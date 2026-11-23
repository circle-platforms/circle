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

export class WeComApplication {
  private token: string | null = null;
  private expires = 0;
  private fetching?: Promise<string>;
  private failed = false;
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
    if (!response.ok) throw new Error('企业应用读取失败');
    const result = await response.json();
    if (result.errcode !== 0) throw new Error('企业应用读取失败');
    return result;
  }

  private access() {
    if (this.failed) throw new Error('企业应用尚未通过认证');
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
          throw new Error('企业应用认证失败');
        this.expires = Date.now() + Math.max(0, result.expires_in - 60) * 1000;
        this.token = result.access_token;
        return result.access_token as string;
      })
      .catch(() => {
        this.failed = true;
        throw new Error('企业应用尚未通过认证');
      })
      .finally(() => {
        this.fetching = undefined;
      });
    return this.fetching;
  }

  async fromCode(code: string) {
    const result = await this.call('/cgi-bin/auth/getuserinfo', {
      access_token: await this.access(),
      code,
    });
    if (typeof result.userid !== 'string' || !result.userid)
      throw new Error('没有获得企业成员身份');
    return result.userid as string;
  }

  async fromBot(sender: string) {
    const result = await this.call(
      '/cgi-bin/batch/openuserid_to_userid',
      { access_token: await this.access() },
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
      (!pairs || pairs.length === 0)
    )
      return sender;
    throw new Error('未能核对机器人发件人');
  }
}
