import { describe, it, expect } from "vitest";
import { filterAndSortLog, presetRange, type LogTxn } from "@/lib/transaction-log";

function txn(over: Partial<LogTxn>): LogTxn {
  return {
    id: "t",
    posted_at: "2026-06-10",
    merchant_name: "Tesco",
    amount: 10,
    currency: "EUR",
    is_recurring: false,
    category_id: "food",
    ...over,
  };
}

const NAMES = { food: "Food & drink", transport: "Transport" };
const NONE = { search: "", range: { from: null, to: null }, categoryNames: NAMES };

describe("presetRange", () => {
  it("returns an inclusive range ending today", () => {
    expect(presetRange("30D", "2026-06-20")).toEqual({ from: "2026-05-21", to: "2026-06-20" });
    expect(presetRange("90D", "2026-06-20")).toEqual({ from: "2026-03-22", to: "2026-06-20" });
  });
});

describe("filterAndSortLog", () => {
  it("searches merchant and category name, case-insensitively", () => {
    const txns = [
      txn({ id: "a", merchant_name: "Tesco", category_id: "food" }),
      txn({ id: "b", merchant_name: "Uber", category_id: "transport" }),
    ];
    expect(
      filterAndSortLog(txns, { ...NONE, search: "tes", sortKey: "date", sortDir: "desc" }).map(
        (t) => t.id,
      ),
    ).toEqual(["a"]);
    // "transport" matches by category name even though the merchant is "Uber".
    expect(
      filterAndSortLog(txns, { ...NONE, search: "transp", sortKey: "date", sortDir: "desc" }).map(
        (t) => t.id,
      ),
    ).toEqual(["b"]);
  });

  it("filters by inclusive date range", () => {
    const txns = [
      txn({ id: "a", posted_at: "2026-06-01" }),
      txn({ id: "b", posted_at: "2026-06-15" }),
      txn({ id: "c", posted_at: "2026-06-30" }),
    ];
    const out = filterAndSortLog(txns, {
      ...NONE,
      range: { from: "2026-06-10", to: "2026-06-20" },
      sortKey: "date",
      sortDir: "asc",
    });
    expect(out.map((t) => t.id)).toEqual(["b"]);
  });

  it("sorts by amount, date, merchant, and category in both directions", () => {
    const txns = [
      txn({
        id: "a",
        amount: 30,
        posted_at: "2026-06-01",
        merchant_name: "Zara",
        category_id: "transport",
      }),
      txn({
        id: "b",
        amount: 10,
        posted_at: "2026-06-20",
        merchant_name: "Aldi",
        category_id: "food",
      }),
      txn({
        id: "c",
        amount: 20,
        posted_at: "2026-06-10",
        merchant_name: "Migros",
        category_id: "food",
      }),
    ];
    const ids = (k: "date" | "merchant" | "category" | "amount", d: "asc" | "desc") =>
      filterAndSortLog(txns, { ...NONE, search: "", sortKey: k, sortDir: d }).map((t) => t.id);

    expect(ids("amount", "desc")).toEqual(["a", "c", "b"]);
    expect(ids("amount", "asc")).toEqual(["b", "c", "a"]);
    expect(ids("date", "desc")).toEqual(["b", "c", "a"]);
    expect(ids("merchant", "asc")).toEqual(["b", "c", "a"]); // Aldi, Migros, Zara
    // category: food(b,c) then transport(a); id tiebreak keeps b before c.
    expect(ids("category", "asc")).toEqual(["b", "c", "a"]);
  });

  it("returns everything when search and range are empty", () => {
    const txns = [txn({ id: "a" }), txn({ id: "b" })];
    expect(filterAndSortLog(txns, { ...NONE, sortKey: "date", sortDir: "desc" })).toHaveLength(2);
  });
});
