import { GrammyError, HttpError } from "grammy";
import { Deque } from "../util.js";

/** Thrown into a lane to signal "Telegram said slow down" from code that has no GrammyError. */
export class RateLimited extends Error {
  constructor(readonly retryAfter: number) {
    super(`rate limited, retry after ${retryAfter}s`);
  }
}

/** A job was discarded because it waited longer than its maxAgeMs. */
export class Dropped extends Error {
  constructor() {
    super("dropped: waited too long in the queue");
  }
}

export interface LaneOptions {
  name: string;
  /** Starting rate, calls per second. */
  rate: number;
  /** Rate never drops below this, even after repeated 429s. */
  minRate: number;
  /** Rate never climbs above this. */
  maxRate: number;
  /** Maximum calls in flight at once. */
  maxInflight: number;
  /** Number of priority levels; 0 is the most urgent. */
  priorities?: number;
  /** Minimum gap between two calls for the same chat. */
  perChatMs?: number;
}

export interface JobOptions {
  priority?: number;
  chatId?: number;
  /** Discard the job (reject with Dropped) if it is still queued after this long. */
  maxAgeMs?: number;
}

interface Job {
  fn: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  priority: number;
  chatId?: number;
  maxAgeMs?: number;
  enqueuedAt: number;
  attempts: number;
}

const MAX_NETWORK_RETRIES = 3;

/**
 * One rate-limited path to Telegram: a token bucket in front of priority queues.
 *
 * - On a 429 the lane pauses for the delay Telegram asked for and halves its rate.
 * - After a quiet period it raises the rate again, step by step, up to maxRate.
 * - Network errors are retried with backoff; everything else is the caller's problem.
 */
export class Lane {
  readonly name: string;
  rate: number;
  readonly stats = { ok: 0, limited: 0, dropped: 0, failed: 0 };

  private readonly opts: LaneOptions;
  private readonly queues: Deque<Job>[];
  private delayed: { at: number; job: Job }[] = [];
  private tokens: number;
  private lastRefill = Date.now();
  private pausedUntil = 0;
  private inflight = 0;
  private timer: NodeJS.Timeout | null = null;
  private timerAt = 0;
  private lastLimitedAt = 0;
  private lastRaisedAt = Date.now();
  private chatNext = new Map<number, number>();

  constructor(opts: LaneOptions) {
    this.opts = opts;
    this.name = opts.name;
    this.rate = opts.rate;
    this.tokens = this.capacity;
    this.queues = Array.from({ length: opts.priorities ?? 1 }, () => new Deque<Job>());
  }

  schedule<T>(fn: () => Promise<T>, o: JobOptions = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const priority = Math.min(Math.max(o.priority ?? 0, 0), this.queues.length - 1);
      this.queues[priority]!.push({
        fn,
        resolve: resolve as (v: unknown) => void,
        reject,
        priority,
        chatId: o.chatId,
        maxAgeMs: o.maxAgeMs,
        enqueuedAt: Date.now(),
        attempts: 0,
      });
      this.pump();
    });
  }

  /** Bucket size: a third of a second's worth, so an idle lane cannot fire a full second at once. */
  private get capacity(): number {
    return Math.max(1, this.rate / 3);
  }

  /** Jobs waiting (not counting those in flight). */
  get depth(): number {
    let n = this.delayed.length;
    for (const q of this.queues) n += q.length;
    return n;
  }

  /** Age of the oldest waiting job, in ms. */
  get oldestAgeMs(): number {
    let oldest = Infinity;
    for (const q of this.queues) {
      const j = q.peek();
      if (j && j.enqueuedAt < oldest) oldest = j.enqueuedAt;
    }
    return oldest === Infinity ? 0 : Date.now() - oldest;
  }

  get paused(): boolean {
    return Date.now() < this.pausedUntil;
  }

  private pump = (): void => {
    const now = Date.now();
    this.releaseDelayed(now);
    this.refill(now);

    if (now < this.pausedUntil) return this.arm(this.pausedUntil - now);

    while (this.tokens >= 1 && this.inflight < this.opts.maxInflight) {
      const job = this.next(now);
      if (!job) break;
      this.tokens -= 1;
      this.run(job);
    }

    if (this.depth === 0) return;
    let wait = this.tokens >= 1 ? 50 : ((1 - this.tokens) / this.rate) * 1000;
    for (const d of this.delayed) wait = Math.min(wait, d.at - now);
    this.arm(Math.max(wait, 2));
  };

  private arm(ms: number): void {
    const at = Date.now() + ms;
    if (this.timer && this.timerAt <= at) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerAt = at;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump();
    }, ms);
  }

  private refill(now: number): void {
    const elapsed = (now - this.lastRefill) / 1000;
    this.lastRefill = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.rate);

    // Additive increase: after 10 quiet seconds, add 10% every 5 seconds while there is demand.
    if (
      this.rate < this.opts.maxRate &&
      this.depth > 0 &&
      now - this.lastLimitedAt > 10_000 &&
      now - this.lastRaisedAt > 5_000
    ) {
      this.rate = Math.min(this.opts.maxRate, this.rate * 1.1 + 0.5);
      this.lastRaisedAt = now;
    }
  }

  private releaseDelayed(now: number): void {
    if (this.delayed.length === 0) return;
    const still: typeof this.delayed = [];
    for (const d of this.delayed) {
      if (d.at <= now) this.queues[d.job.priority]!.pushFront(d.job);
      else still.push(d);
    }
    this.delayed = still;
  }

  private next(now: number): Job | undefined {
    for (const q of this.queues) {
      for (;;) {
        const job = q.shift();
        if (!job) break;
        if (job.maxAgeMs !== undefined && now - job.enqueuedAt > job.maxAgeMs) {
          this.stats.dropped++;
          job.reject(new Dropped());
          continue;
        }
        if (this.opts.perChatMs && job.chatId !== undefined) {
          const free = this.chatNext.get(job.chatId) ?? 0;
          if (free > now) {
            this.delayed.push({ at: free, job });
            continue;
          }
          this.chatNext.set(job.chatId, now + this.opts.perChatMs);
          if (this.chatNext.size > 100_000) this.sweepChats(now);
        }
        return job;
      }
    }
    return undefined;
  }

  private sweepChats(now: number): void {
    for (const [k, t] of this.chatNext) if (t <= now) this.chatNext.delete(k);
  }

  private run(job: Job): void {
    this.inflight++;
    job
      .fn()
      .then(
        (value) => {
          this.stats.ok++;
          job.resolve(value);
        },
        (err) => this.onError(job, err),
      )
      .finally(() => {
        this.inflight--;
        this.pump();
      });
  }

  private onError(job: Job, err: unknown): void {
    const now = Date.now();
    const retryAfter = retryAfterOf(err);
    if (retryAfter !== null) {
      this.stats.limited++;
      this.pausedUntil = Math.max(this.pausedUntil, now + retryAfter * 1000);
      this.tokens = 0;
      // Several in-flight calls usually fail together; halve only once per second.
      if (now - this.lastLimitedAt > 1000) this.rate = Math.max(this.opts.minRate, this.rate / 2);
      this.lastLimitedAt = now;
      if (this.opts.perChatMs && job.chatId !== undefined) this.chatNext.delete(job.chatId);
      this.queues[job.priority]!.pushFront(job);
      return;
    }
    if (err instanceof HttpError && job.attempts < MAX_NETWORK_RETRIES) {
      job.attempts++;
      this.delayed.push({ at: now + 250 * 2 ** job.attempts, job });
      return;
    }
    this.stats.failed++;
    job.reject(err);
  }
}

function retryAfterOf(err: unknown): number | null {
  if (err instanceof RateLimited) return err.retryAfter;
  if (err instanceof GrammyError && err.error_code === 429) return err.parameters?.retry_after ?? 1;
  return null;
}
