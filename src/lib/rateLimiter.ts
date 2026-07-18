export type Limit = {
  interval: number;
  count: number;
  raw?: boolean;
};

export function wait(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(() => resolve(), ms);
  });
}

export class RateLimiter {
  private interval: number;
  private count: number;
  private raw: boolean;
  private releases: number[] = [];
  private lock: Promise<void> = Promise.resolve();

  constructor({ interval, count, raw = false }: Limit) {
    this.interval = interval;
    this.count = count;
    this.raw = raw;
  }

  private async _withLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async _waitForRelease(counter: number): Promise<void> {
    while (true) {
      const now = Date.now();
      const expiryTime = now - this.interval;
      this.releases = this.releases.filter((s) => s > expiryTime);

      if (this.releases.length === 0) {
        return;
      }
      if (this.releases.length + counter <= this.count) {
        return;
      }

      let deadline: number;
      if (counter > this.count) {
        // while in window — wait for full empty
        deadline = this.releases[this.releases.length - 1] + this.interval;
      } else {
        const k = this.releases.length + counter - this.count;
        deadline = this.releases[k - 1] + this.interval;
      }

      const waitMs = deadline - now;
      if (waitMs > 0) {
        await wait(waitMs);
      }
    }
  }

  private _release(counter: number): void {
    let releaseTime = Date.now();
    let remaining = this.count;
    for (let i = 0; i < counter; i++) {
      this.releases.push(releaseTime);
      remaining -= 1;
      if (remaining === 0) {
        releaseTime += this.interval;
        remaining = this.count;
      }
    }
  }

  public acquire(weight = 1): Promise<void> {
    return this._withLock(async () => {
      const counter = this.raw ? 1 : weight;
      await this._waitForRelease(counter);
      this._release(counter);
    });
  }
}
