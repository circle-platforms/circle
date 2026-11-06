// A scan takes at most a tenth of the time, however often something asks for one.
const REST_PER_SCAN_TIME = 9;
const LONGEST_REST_MS = 30_000;

/** Runs one scan at a time, and rests after each in proportion to how long it took. */
export class ScanPacer {
  private running = false;
  private again = false;
  private stopped = false;
  private nextAt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly scan: () => Promise<void>) {}
  request(): void {
    if (this.stopped) return;
    // What changed during a scan may have been missed by it.
    if (this.running) {
      this.again = true;
      return;
    }
    if (this.timer) return;
    const rest = this.nextAt - Date.now();
    if (rest > 0) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.request();
      }, rest);
      this.timer.unref?.();
      return;
    }
    const started = Date.now();
    this.running = true;
    void this.scan().finally(() => {
      this.running = false;
      this.nextAt =
        Date.now() +
        Math.min(LONGEST_REST_MS, (Date.now() - started) * REST_PER_SCAN_TIME);
      if (!this.again) return;
      this.again = false;
      this.request();
    });
  }
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
