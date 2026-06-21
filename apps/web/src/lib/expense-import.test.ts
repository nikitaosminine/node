import { describe, it, expect } from "vitest";
import {
  parseAmount,
  monthOf,
  externalId,
  isValidIsoDate,
  coercePreviewRow,
  buildTransactionInserts,
  aggregateIncomeByMonth,
  foreignCurrencies,
  type PreviewRow,
  type ReviewRow,
} from "@/lib/expense-import";

const CATS = { FOOD_AND_DRINK: "cat-food", INCOME: "cat-income", RENT_AND_UTILITIES: "cat-rent" };

function review(overrides: Partial<ReviewRow>): ReviewRow {
  return {
    posted_at: "2026-06-10",
    merchant_name: "Tesco",
    amount: 12.5,
    currency: "EUR",
    kind: "spend",
    is_recurring: false,
    pfc_primary: "FOOD_AND_DRINK",
    category_id: "cat-food",
    external_id: null,
    confidence: 0.9,
    include: true,
    ...overrides,
  };
}

describe("parseAmount", () => {
  it("handles plain, European, and signed formats as positive numbers", () => {
    expect(parseAmount("12.50")).toBe(12.5);
    expect(parseAmount("1,234.56")).toBe(1234.56);
    expect(parseAmount("€1.234,56")).toBe(1234.56);
    expect(parseAmount("-12,50")).toBe(12.5);
    expect(parseAmount(42)).toBe(42);
    expect(parseAmount("not a number")).toBe(0);
  });
});

describe("isValidIsoDate", () => {
  it("accepts real dates and rejects impossible ones", () => {
    expect(isValidIsoDate("2026-06-10")).toBe(true);
    expect(isValidIsoDate("2026-13-40")).toBe(false); // month 13, day 40
    expect(isValidIsoDate("2026-02-31")).toBe(false); // Feb 31st
    expect(isValidIsoDate("2026-6-1")).toBe(false); // not zero-padded
    expect(isValidIsoDate("nope")).toBe(false);
  });
});

describe("monthOf / externalId", () => {
  it("returns the first of the month", () => {
    expect(monthOf("2026-06-19")).toBe("2026-06-01");
  });
  it("dedups only on a real bank reference", () => {
    expect(externalId("  TXN-99 ")).toBe("TXN-99");
    expect(externalId("   ")).toBeNull();
    expect(externalId(null)).toBeNull();
  });
});

describe("coercePreviewRow", () => {
  it("resolves the category from the PFCv2 primary and clamps confidence", () => {
    const raw: PreviewRow = {
      posted_at: "2026-06-10",
      merchant_name: "  Tesco  ",
      amount: "€12,50",
      currency: "eur",
      kind: "spend",
      is_recurring: false,
      pfc_primary: "food_and_drink",
      external_ref: "REF1",
      confidence: 1.5,
    };
    const row = coercePreviewRow(raw, CATS, "EUR");
    expect(row).toMatchObject({
      merchant_name: "Tesco",
      amount: 12.5,
      currency: "EUR",
      pfc_primary: "FOOD_AND_DRINK",
      category_id: "cat-food",
      external_id: "REF1",
      confidence: 1,
      include: true,
    });
  });

  it("falls back to uncategorized for an unknown primary", () => {
    const raw: PreviewRow = {
      posted_at: "2026-06-01",
      merchant_name: "x",
      amount: 1,
      currency: "EUR",
      kind: "spend",
      is_recurring: false,
      pfc_primary: "MADE_UP",
      external_ref: null,
      confidence: 0.8,
    };
    expect(coercePreviewRow(raw, CATS, "EUR").category_id).toBeNull();
  });
});

describe("buildTransactionInserts", () => {
  it("includes spend + recurring spend, excludes income, excluded, and invalid rows", () => {
    const rows: ReviewRow[] = [
      review({ merchant_name: "Tesco" }),
      review({
        merchant_name: "Rent",
        is_recurring: true,
        pfc_primary: "RENT_AND_UTILITIES",
        category_id: "cat-rent",
        amount: 900,
      }),
      review({ merchant_name: "Salary", kind: "income", category_id: "cat-income", amount: 3000 }),
      review({ merchant_name: "Excluded", include: false }),
      review({ merchant_name: "BadDate", posted_at: "nope" }),
      review({ merchant_name: "ImpossibleMonth", posted_at: "2026-13-40" }),
      review({ merchant_name: "Feb31", posted_at: "2026-02-31" }),
      review({ merchant_name: "ZeroAmt", amount: 0 }),
    ];
    const inserts = buildTransactionInserts(rows, "u1", "EUR");
    expect(inserts.map((i) => i.merchant_name)).toEqual(["Tesco", "Rent"]);
    expect(inserts[1]).toMatchObject({
      is_recurring: true,
      source: "csv",
      currency: "EUR",
      user_id: "u1",
    });
  });

  it("forces the base currency on every row (single-currency v1)", () => {
    const inserts = buildTransactionInserts([review({ currency: "USD" })], "u1", "EUR");
    expect(inserts[0].currency).toBe("EUR");
  });
});

describe("aggregateIncomeByMonth", () => {
  it("sums included income rows per month", () => {
    const rows: ReviewRow[] = [
      review({ kind: "income", amount: 3000, posted_at: "2026-06-25" }),
      review({ kind: "income", amount: 200, posted_at: "2026-06-02" }),
      review({ kind: "income", amount: 3000, posted_at: "2026-05-25" }),
      review({ kind: "income", amount: 999, posted_at: "2026-06-25", include: false }),
      review({ kind: "income", amount: 500, posted_at: "2026-02-31" }), // impossible — excluded
      review({ kind: "spend", amount: 50 }),
    ];
    const income = aggregateIncomeByMonth(rows, "u1", "EUR");
    expect(income).toEqual([
      { user_id: "u1", month: "2026-06-01", amount: 3200, currency: "EUR" },
      { user_id: "u1", month: "2026-05-01", amount: 3000, currency: "EUR" },
    ]);
  });
});

describe("foreignCurrencies", () => {
  it("lists detected currencies that differ from base", () => {
    const rows = [
      review({ currency: "EUR" }),
      review({ currency: "USD" }),
      review({ currency: "GBP" }),
    ];
    expect(foreignCurrencies(rows, "EUR").sort()).toEqual(["GBP", "USD"]);
  });
});
