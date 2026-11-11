import { createHash, randomBytes } from "node:crypto";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Random base62 string. 10 chars is about 59 bits: not guessable, not enumerable. */
export function randomCode(len = 10): string {
  const bytes = randomBytes(len);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/** In-memory "not again before" map, used for per-user cooldowns and notice coalescing. */
export class Cooldown {
  private until = new Map<string, number>();

  active(key: string): boolean {
    const t = this.until.get(key);
    return t !== undefined && t > Date.now();
  }

  set(key: string, ms: number): void {
    if (ms <= 0) return;
    this.until.set(key, Date.now() + ms);
    if (this.until.size > 200_000) this.sweep();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, t] of this.until) if (t <= now) this.until.delete(k);
  }
}

/** Queue with O(1) push/shift; Array.shift is O(n) and the send queue can hold 10K+ jobs. */
export class Deque<T> {
  private items: (T | undefined)[] = [];
  private head = 0;

  get length(): number {
    return this.items.length - this.head;
  }

  push(v: T): void {
    this.items.push(v);
  }

  pushFront(v: T): void {
    if (this.head > 0) this.items[--this.head] = v;
    else this.items.unshift(v);
  }

  peek(): T | undefined {
    return this.items[this.head];
  }

  shift(): T | undefined {
    if (this.head >= this.items.length) return undefined;
    const v = this.items[this.head];
    this.items[this.head++] = undefined;
    if (this.head > 1024 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return v;
  }
}

/** Runs `fn` every `ms`, never overlapping itself. Returns a stop function that waits for the current run. */
export function every(ms: number, fn: () => Promise<void>, onError: (e: unknown) => void) {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let current: Promise<void> = Promise.resolve();
  const tick = () => {
    if (stopped) return;
    current = fn()
      .catch(onError)
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, ms);
      });
  };
  timer = setTimeout(tick, ms);
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await current;
  };
}
