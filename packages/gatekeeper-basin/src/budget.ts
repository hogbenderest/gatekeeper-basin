// Per-binding daily scan budget. Counters live in the Gatekeeper Durable Object's
// storage (a facet exists per binding, so the budget is per binding per workspace),
// keyed by UTC day, counted from the engine's own metrics.bytes_scanned. The pure
// logic is here so tests can pin day-rollover and cap behaviour without a DO.

export interface BudgetStore {
  get(day: string): Promise<number>;
  add(day: string, bytes: number): Promise<void>;
}

export interface BudgetSnapshot {
  capBytes: number;
  usedBytes: number;
  resetsAtUtc: string;
}

/** UTC "YYYY-MM-DD" for a timestamp. */
export function budgetDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** The next UTC midnight after `now`, ISO 8601. */
export function budgetResetsAt(now: Date): string {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return next.toISOString();
}

/** Parse a positive MB cap from an env var, with a default. */
export function budgetCapMb(value: string | undefined, fallbackMb = 2048): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallbackMb;
}

export class BudgetExhaustedError extends Error {
  constructor() {
    super("This binding's daily Basin scan budget is exhausted; it resets at UTC midnight.");
    this.name = "BudgetExhaustedError";
  }
}

export class Budget {
  readonly capBytes: number;
  readonly #store: BudgetStore;
  readonly #now: () => Date;

  constructor(store: BudgetStore, capBytes: number, now: () => Date = () => new Date()) {
    this.capBytes = capBytes;
    this.#store = store;
    this.#now = now;
  }

  /**
   * Claims `estimateBytes` against the day's counter before the outbound query, so
   * concurrent queries cannot all pass one bare check (audit run 1, finding 1: the DO
   * input gate opens across the fetch, and assert-then-record let N interleaved
   * queries each see the same counter). Settles with record(actual - estimate);
   * record ignores non-positive deltas, so a query that scanned less than its
   * reservation keeps the reservation - the gatekeeper-x overshoot bound.
   */
  async assertAndReserve(estimateBytes: number): Promise<void> {
    const day = budgetDay(this.#now());
    const used = await this.#store.get(day);
    if (used + estimateBytes > this.capBytes) throw new BudgetExhaustedError();
    await this.#store.add(day, estimateBytes);
  }

  /** Record bytes scanned against the day's counter. Never throws. */
  async record(bytesScanned: number): Promise<void> {
    if (!(bytesScanned > 0)) return;
    const day = budgetDay(this.#now());
    try {
      await this.#store.add(day, bytesScanned);
    } catch {
      // A failed counter write must not fail the query it accounts for.
    }
  }

  async snapshot(): Promise<BudgetSnapshot> {
    const now = this.#now();
    return {
      capBytes: this.capBytes,
      usedBytes: await this.#store.get(budgetDay(now)),
      resetsAtUtc: budgetResetsAt(now),
    };
  }
}

/**
 * A BudgetStore over a Durable Object's synchronous KV view, with one key per UTC day.
 * Old keys are cheap to leave behind: a handful of small integers per binding.
 */
export function kvBudgetStore(
  kv: { get<T>(key: string): T | undefined; put<T>(key: string, value: T): void },
): BudgetStore {
  return {
    async get(day: string): Promise<number> {
      const v = kv.get<number>(`budget:${day}`);
      return typeof v === "number" && Number.isFinite(v) ? v : 0;
    },
    async add(day: string, bytes: number): Promise<void> {
      const current = kv.get<number>(`budget:${day}`) ?? 0;
      kv.put(`budget:${day}`, current + bytes);
    },
  };
}
