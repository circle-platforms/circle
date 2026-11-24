interface Application {
  tenant: string;
  application: string;
  secret: string;
}
export function loginUrl(
  app: Pick<Application, 'tenant' | 'application'>,
  callback: string,
  state: string,
) {
  const url = new URL('https://login.work.weixin.qq.com/wwlogin/sso/login');
  url.search = new URLSearchParams({
    login_type: 'CorpApp',
    appid: app.tenant,
    agentid: app.application,
    redirect_uri: callback,
    state,
  }).toString();
  return url.href;
}

const EXPIRED_TOKEN_ERRCODES = new Set([42001, 40014, 42007]);

export class WeComApiError extends Error {
  readonly errcode: number;

  constructor(errcode: number, message = '企业应用读取失败') {
    super(message);
    this.name = 'WeComApiError';
    this.errcode = errcode;
  }
}

export class WeComHttpError extends Error {
  readonly status: number;

  constructor(status: number, message = '企业应用读取失败') {
    super(message);
    this.name = 'WeComHttpError';
    this.status = status;
  }
}

export class WeComApplication {
  private token: string | null = null;
  private expires = 0;
  private fetching?: Promise<string>;
  readonly app: Application;
  readonly fetcher: typeof fetch;
  constructor(app: Application, fetcher = fetch) {
    this.app = app;
    this.fetcher = fetcher;
  }

  private async call(
    path: string,
    params: Record<string, string>,
    body?: unknown,
  ) {
    const url = new URL(path, 'https://qyapi.weixin.qq.com');
    url.search = new URLSearchParams(params).toString();
    const response = await this.fetcher(url, {
      method: body ? 'POST' : 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      ...(body
        ? {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }
        : {}),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new WeComHttpError(response.status, '企业应用读取失败');
    }
    const result = await response.json();
    if (result.errcode !== 0) {
      const code = typeof result.errcode === 'number' ? result.errcode : -1;
      throw new WeComApiError(code, '企业应用读取失败');
    }
    return result;
  }

  private access() {
    if (this.token && this.expires > Date.now())
      return Promise.resolve(this.token);
    this.fetching ??= this.call('/cgi-bin/gettoken', {
      corpid: this.app.tenant,
      corpsecret: this.app.secret,
    })
      .then((result) => {
        if (
          typeof result.access_token !== 'string' ||
          !result.access_token ||
          !Number.isFinite(result.expires_in)
        )
          throw new WeComApiError(-1, '企业应用认证失败');
        this.expires = Date.now() + Math.max(0, result.expires_in - 60) * 1000;
        this.token = result.access_token;
        return result.access_token as string;
      })
      .catch((error: unknown) => {
        this.token = null;
        this.expires = 0;
        if (error instanceof WeComApiError) {
          throw new WeComApiError(error.errcode, '企业应用尚未通过认证');
        }
        if (error instanceof WeComHttpError) {
          throw new WeComHttpError(error.status, '企业应用尚未通过认证');
        }
        throw new Error('企业应用尚未通过认证', { cause: error });
      })
      .finally(() => {
        this.fetching = undefined;
      });
    return this.fetching;
  }

  private async callWithToken(
    path: string,
    params: Record<string, string>,
    body?: unknown,
  ) {
    const token = await this.access();
    try {
      return await this.call(path, { ...params, access_token: token }, body);
    } catch (error) {
      if (
        error instanceof WeComApiError &&
        EXPIRED_TOKEN_ERRCODES.has(error.errcode)
      ) {
        if (this.token === token) {
          this.token = null;
          this.expires = 0;
        }
        const freshToken = await this.access();
        return await this.call(
          path,
          { ...params, access_token: freshToken },
          body,
        );
      }
      throw error;
    }
  }

  async fromCode(code: string) {
    const result = await this.callWithToken('/cgi-bin/auth/getuserinfo', {
      code,
    });
    if (typeof result.userid !== 'string' || !result.userid)
      throw new Error('没有获得企业成员身份');
    return result.userid as string;
  }

  async fromBot(sender: string) {
    const result = await this.callWithToken(
      '/cgi-bin/batch/openuserid_to_userid',
      {},
      { open_userid_list: [sender] },
    );
    const pairs = result.userid_list;
    if (
      Array.isArray(pairs) &&
      pairs.length === 1 &&
      pairs[0]?.open_userid === sender &&
      typeof pairs[0]?.userid === 'string' &&
      pairs[0].userid
    )
      return pairs[0].userid as string;
    // The API also returns an already-plaintext userid in this list. The Hub must still find an exact bound subject.
    if (
      Array.isArray(result.invalid_open_userid_list) &&
      result.invalid_open_userid_list.length === 1 &&
      result.invalid_open_userid_list[0] === sender &&
      (!pairs || (Array.isArray(pairs) && pairs.length === 0))
    )
      return sender;
    throw new WeComApiError(-2, '未能核对机器人发件人');
  }
}
