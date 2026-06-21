import { describe, it, expect } from "vitest";
import { buildCategoryMix, type MixTxn } from "@/lib/category-mix";

function txn(over: Partial<MixTxn>): MixTxn {
  return {
    merchant_name: "Tesco",
    amount: 10,
    is_recurring: false,
    category_id: "food",
    ...over,
  };
}

const NAMES = { food: "Food & drink", transport: "Transport", fun: "Entertainment" };

describe("buildCategoryMix", () => {
  it("ranks categories by amount desc and computes share of the discretionary total", () => {
    const mix = buildCategoryMix(
      [
        txn({ category_id: "food", amount: 60 }),
        txn({ category_id: "transport", amount: 30 }),
        txn({ category_id: "fun", amount: 10 }),
      ],
      NAMES,
    );
    expect(mix.total).toBe(100);
    expect(mix.rows.map((r) => r.name)).toEqual(["Food & drink", "Transport", "Entertainment"]);
    expect(mix.rows[0]).toMatchObject({ amount: 60, sharePct: 60, widthPct: 100 });
    expect(mix.rows[1]).toMatchObject({ amount: 30, sharePct: 30, widthPct: 50 }); // 30/60
  });

  it("excludes recurring (fixed) spend from the mix", () => {
    const mix = buildCategoryMix(
      [
        txn({ category_id: "food", amount: 40 }),
        txn({ category_id: "transport", amount: 900, is_recurring: true }), // rent → excluded
      ],
      NAMES,
    );
    expect(mix.total).toBe(40);
    expect(mix.rows).toHaveLength(1);
    expect(mix.rows[0].name).toBe("Food & drink");
  });

  it("rolls up merchants within a category, ranked desc with per-category share", () => {
    const mix = buildCategoryMix(
      [
        txn({ category_id: "food", merchant_name: "Tesco", amount: 30 }),
        txn({ category_id: "food", merchant_name: "Tesco", amount: 10 }),
        txn({ category_id: "food", merchant_name: "Pret", amount: 10 }),
      ],
      NAMES,
    );
    const row = mix.rows[0];
    expect(row.amount).toBe(50);
    expect(row.count).toBe(3);
    expect(row.merchants).toEqual([
      { name: "Tesco", amount: 40, count: 2, sharePct: 80 },
      { name: "Pret", amount: 10, count: 1, sharePct: 20 },
    ]);
  });

  it("labels missing category as Uncategorized and skips non-positive amounts", () => {
    const mix = buildCategoryMix(
      [
        txn({ category_id: null, amount: 25 }),
        txn({ category_id: "food", amount: 0 }), // refund/zero → not spend mix
        txn({ category_id: "food", amount: -5 }),
      ],
      NAMES,
    );
    expect(mix.total).toBe(25);
    expect(mix.rows).toHaveLength(1);
    expect(mix.rows[0]).toMatchObject({ categoryId: null, name: "Uncategorized", amount: 25 });
  });

  it("handles an empty list without dividing by zero", () => {
    const mix = buildCategoryMix([], NAMES);
    expect(mix.total).toBe(0);
    expect(mix.rows).toEqual([]);
  });
});
