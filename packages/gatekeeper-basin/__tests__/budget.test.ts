// Budget semantics: per-binding per-UTC-day counting, reserve-then-settle
// concurrency bounds, cap enforcement, rollover, and the DO storage adapter's
// key shape. The reservation model is the fix for audit run 1, finding 1: the
// DO input gate opens across the outbound fetch, so a bare check-then-record
// let N interleaved queries each pass the same assert.

import { describe, expect, it } from "vitest";
import {
  Budget,
  budgetCapMb,
  budgetDay,
  budgetResetsAt,
  BudgetExhaustedError,
  kvBudgetStore,
} from "../src/budget.js";

function memoryStore() {
  const map = new Map<string, number>();
  return {
    store: {
      async get(day: string) {
        return map.get(day) ?? 0;
      },
      async add(day: string, bytes: number) {
        map.set(day, (map.get(day) ?? 0) + bytes);
      },
    },
    map,
  };
}

const at = (iso: string) => () => new Date(iso);

describe("budget day helpers", () => {
  it("groups by UTC day", () => {
    expect(budgetDay(new Date("2026-10-26T23:59:59Z"))).toBe("2026-10-26");
    expect(budgetDay(new Date("2026-10-27T00:00:00Z"))).toBe("2026-10-27");
  });

  it("resets at the next UTC midnight", () => {
    expect(budgetResetsAt(new Date("2026-10-26T15:00:00Z"))).toBe("2026-10-27T00:00:00.000Z");
    expect(budgetResetsAt(new Date("2026-10-26T00:00:00.000Z"))).toBe("2026-10-27T00:00:00.000Z");
  });

  it("parses the MB cap with a fallback", () => {
    expect(budgetCapMb("512")).toBe(512);
    expect(budgetCapMb(undefined, 2048)).toBe(2048);
    expect(budgetCapMb("not-a-number")).toBe(2048);
    expect(budgetCapMb("0")).toBe(2048);
    expect(budgetCapMb("-5")).toBe(2048);
  });
});

describe("Budget reserve-then-settle", () => {
  it("claims the estimate before execution, so concurrent queries accumulate", async () => {
    const { store, map } = memoryStore();
    const budget = new Budget(store, 1000, at("2026-10-26T10:00:00Z"));
    // Three interleaved queries each reserve before any fetch settles
    await budget.assertAndReserve(10);
    await budget.assertAndReserve(10);
    await budget.assertAndReserve(10);
    expect(map.get("2026-10-26")).toBe(30);
  });

  it("rejects a reservation that would exceed the cap, bounding concurrent overshoot", async () => {
    const { store } = memoryStore();
    const budget = new Budget(store, 100, at("2026-10-26T10:00:00Z"));
    await budget.assertAndReserve(50);
    await budget.assertAndReserve(50); // exactly at the cap: nothing more fits
    await expect(budget.assertAndReserve(50)).rejects.toBeInstanceOf(BudgetExhaustedError);
    // A zero reservation (free statements) still cannot start once the cap is full.
    await expect(budget.assertAndReserve(1)).rejects.toBeInstanceOf(BudgetExhaustedError);
  });

  it("settles upward when the actual scan exceeds the reservation", async () => {
    const { store } = memoryStore();
    const budget = new Budget(store, 1000, at("2026-10-26T10:00:00Z"));
    await budget.assertAndReserve(10);
    await budget.record(25 - 10); // actual 25: settle the difference
    const snapshot = await budget.snapshot();
    expect(snapshot.usedBytes).toBe(25);
  });

  it("keeps the reservation when the actual scan is below it", async () => {
    const { store } = memoryStore();
    const budget = new Budget(store, 1000, at("2026-10-26T10:00:00Z"));
    await budget.assertAndReserve(20);
    await budget.record(5 - 20); // negative delta: ignored, reservation stands
    expect((await budget.snapshot()).usedBytes).toBe(20);
  });

  it("one query larger than the whole cap still executes (inherent overshoot), the next is refused", async () => {
    const { store } = memoryStore();
    const budget = new Budget(store, 100, at("2026-10-26T10:00:00Z"));
    await budget.assertAndReserve(10); // the default 10 MB estimate fits
    await budget.record(500 - 10); // but the actual scan was 500
    await expect(budget.assertAndReserve(10)).rejects.toBeInstanceOf(BudgetExhaustedError);
  });

  it("rolls over at UTC midnight", async () => {
    const { store, map } = memoryStore();
    let now = new Date("2026-10-26T23:30:00Z");
    const budget = new Budget(store, 100, () => now);
    await budget.assertAndReserve(60);
    await expect(budget.assertAndReserve(60)).rejects.toBeInstanceOf(BudgetExhaustedError);
    now = new Date("2026-10-27T00:01:00Z");
    await budget.assertAndReserve(60); // fresh day, fresh counter
    expect(map.get("2026-10-26")).toBe(60);
    expect(map.get("2026-10-27")).toBe(60);
  });

  it("ignores zero, negative, and failed recordings", async () => {
    const { store, map } = memoryStore();
    const failing = {
      async get() {
        return 0;
      },
      async add() {
        throw new Error("storage down");
      },
    };
    const budget = new Budget(failing, 1000, at("2026-10-26T10:00:00Z"));
    await budget.record(0);
    await budget.record(-5);
    await budget.record(100); // swallowed: accounting must not fail the query
    expect(map.size).toBe(0);
  });

  it("snapshots cap, usage, and reset time", async () => {
    const { store } = memoryStore();
    const budget = new Budget(store, 2048, at("2026-10-26T10:00:00Z"));
    await budget.assertAndReserve(1024);
    const snapshot = await budget.snapshot();
    expect(snapshot.capBytes).toBe(2048);
    expect(snapshot.usedBytes).toBe(1024);
    expect(snapshot.resetsAtUtc).toBe("2026-10-27T00:00:00.000Z");
  });
});

describe("kvBudgetStore", () => {
  it("keeps one counter per UTC day under a budget: prefix", () => {
    const stored = new Map<string, unknown>();
    const kv = {
      get<T>(key: string): T | undefined {
        return stored.get(key) as T | undefined;
      },
      put<T>(key: string, value: T): void {
        stored.set(key, value);
      },
    };
    const store = kvBudgetStore(kv);
    const day = budgetDay(new Date("2026-10-26T12:00:00Z"));
    store.add(day, 10);
    store.add(day, 32);
    return store.get(day).then((v) => {
      expect(v).toBe(42);
      expect(stored.has(`budget:${day}`)).toBe(true);
    });
  });
});
