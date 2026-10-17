import { randomUUID } from 'node:crypto';

/** Main-process encrypted storage. This interface is never part of preload. */
export interface RuntimeCredentialStore {
  get(key: string): Promise<string | undefined>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
export interface CredentialRequest {
  type: 'credential-request';
  id: string;
  operation: 'get' | 'put' | 'delete';
  key: string;
  value?: string;
}
export interface CredentialReply {
  type: 'credential-reply';
  id: string;
  ok: boolean;
  value?: string;
  error?: string;
}
const MAX_SECRET_BYTES = 1024 * 1024;
const identity = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
export function validateCredentialRequest(value: unknown): CredentialRequest {
  const request = value as CredentialRequest;
  if (
    !request ||
    request.type !== 'credential-request' ||
    !identity(request.id) ||
    !['get', 'put', 'delete'].includes(request.operation) ||
    typeof request.key !== 'string' ||
    !/^[a-zA-Z0-9._:/-]{1,200}$/.test(request.key) ||
    (request.operation === 'put'
      ? typeof request.value !== 'string' ||
        Buffer.byteLength(request.value) > MAX_SECRET_BYTES
      : request.value !== undefined)
  )
    throw Error('invalid native credential request');
  return request;
}

/** Private RPC client owned by the utility process, independent of runtime commands. */
export class RuntimeCredentialClient implements RuntimeCredentialStore {
  private pending = new Map<
    string,
    {
      resolve(value: string | undefined): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private disposed = false;
  private send: (request: CredentialRequest) => void;
  private timeoutMs: number;
  constructor(send: (request: CredentialRequest) => void, timeoutMs = 30_000) {
    this.send = send;
    this.timeoutMs = timeoutMs;
  }
  get(key: string) {
    return this.request('get', key);
  }
  async put(key: string, value: string) {
    await this.request('put', key, value);
  }
  async delete(key: string) {
    await this.request('delete', key);
  }
  receive(value: unknown): boolean {
    const reply = value as CredentialReply;
    if (!reply || reply.type !== 'credential-reply' || !identity(reply.id))
      return false;
    const pending = this.pending.get(reply.id);
    if (!pending) return false;
    this.pending.delete(reply.id);
    clearTimeout(pending.timer);
    if (
      typeof reply.ok !== 'boolean' ||
      (reply.value !== undefined &&
        (typeof reply.value !== 'string' ||
          Buffer.byteLength(reply.value) > MAX_SECRET_BYTES))
    )
      pending.reject(Error('invalid native credential reply'));
    else if (!reply.ok)
      pending.reject(Error('native credential operation failed'));
    else pending.resolve(reply.value);
    return true;
  }
  close() {
    this.disposed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(Error('native credential channel closed'));
    }
    this.pending.clear();
  }
  private request(
    operation: CredentialRequest['operation'],
    key: string,
    value?: string,
  ): Promise<string | undefined> {
    if (this.disposed)
      return Promise.reject(Error('native credential channel closed'));
    if (this.pending.size >= 64)
      return Promise.reject(Error('native credential channel is busy'));
    const request: CredentialRequest = {
      type: 'credential-request',
      id: randomUUID(),
      operation,
      key,
      ...(value === undefined ? {} : { value }),
    };
    try {
      validateCredentialRequest(request);
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        reject(
          Error(
            'native credential request timed out; stored state must be checked',
          ),
        );
      }, this.timeoutMs);
      this.pending.set(request.id, { resolve, reject, timer });
      try {
        this.send(request);
      } catch {
        clearTimeout(timer);
        this.pending.delete(request.id);
        reject(Error('native credential channel disconnected'));
      }
    });
  }
}

/** Catches handler failures without forwarding exception text that may contain secrets. */
export async function executeCredentialRequest(
  value: unknown,
  store?: RuntimeCredentialStore,
): Promise<CredentialReply | undefined> {
  const id = (value as { id?: unknown } | null)?.id;
  if (!identity(id)) return undefined;
  try {
    const request = validateCredentialRequest(value);
    if (!store) throw Error('credential store unavailable');
    if (request.operation === 'get') {
      const value = await store.get(request.key);
      if (
        value !== undefined &&
        (typeof value !== 'string' ||
          Buffer.byteLength(value) > MAX_SECRET_BYTES)
      )
        throw Error('invalid stored credential');
      return {
        type: 'credential-reply',
        id,
        ok: true,
        ...(value === undefined ? {} : { value }),
      };
    }
    if (request.operation === 'put')
      await store.put(request.key, request.value!);
    else await store.delete(request.key);
    return { type: 'credential-reply', id, ok: true };
  } catch {
    return {
      type: 'credential-reply',
      id,
      ok: false,
      error: 'native credential operation failed',
    };
  }
}
