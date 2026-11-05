import { mkdirSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

export function instanceDataPath(path: string): string {
  const absolute = resolve(path);
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  return realpathSync.native(absolute);
}

export interface InstanceIdentity {
  protocol: 'circle-instance/1';
  build: string;
  version: string;
}

export function differentInstanceBuild(
  own: InstanceIdentity,
  value: unknown,
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const other = value as Partial<InstanceIdentity>;
  return (
    other.protocol === own.protocol &&
    typeof other.build === 'string' &&
    other.build.length > 0 &&
    other.build.length <= 8192 &&
    !/[\x00-\x1f\x7f-\x9f]/.test(other.build) &&
    typeof other.version === 'string' &&
    /^[a-zA-Z0-9.+-]{1,100}$/.test(other.version) &&
    (other.build !== own.build || other.version !== own.version)
  );
}

export class InstanceActivation {
  private ready = false;
  private stopped = false;
  private wanted = false;
  private notice = false;
  private pending?: Promise<void>;

  constructor(
    private readonly activate: () => Promise<void>,
    private readonly notify: () => Promise<void>,
    private readonly failure: (error: unknown) => void,
  ) {}

  request(notice = false): void {
    if (this.stopped) return;
    this.wanted = true;
    this.notice ||= notice;
    this.drain();
  }

  start(): void {
    this.ready = true;
    this.drain();
  }

  stop(): void {
    this.stopped = true;
    this.wanted = false;
    this.notice = false;
  }

  private drain(): void {
    if (!this.ready || this.stopped || !this.wanted || this.pending) return;
    this.wanted = false;
    this.pending = this.activate()
      .then(async () => {
        if (this.stopped || !this.notice) return;
        this.notice = false;
        await this.notify();
      })
      .catch(this.failure)
      .finally(() => {
        this.pending = undefined;
        this.drain();
      });
  }
}
