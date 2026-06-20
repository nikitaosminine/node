import { describe, it, expect } from "vitest";
import { buildMonthHeatmap, type HeatmapTxn } from "@/lib/heatmap";

function txn(over: Partial<HeatmapTxn>): HeatmapTxn {
  return {
    id: "t",
    posted_at: "2026-06-10",
    merchant_name: "Tesco",
    amount: 10,
    is_recurring: false,
    category_id: null,
    ...over,
  };
}

// June 2026 starts on a Monday and has 30 days.
const Y = 2026;
const M = 5; // June, 0-based

describe("buildMonthHeatmap", () => {
  it("sums discretionary per day, excludes recurring as committed", () => {
    const m = buildMonthHeatmap(
      [
        txn({ posted_at: "2026-06-06", amount: 400 }),
        txn({ posted_at: "2026-06-06", amount: 1 }),
        txn({ posted_at: "2026-06-10", amount: 50 }),
        txn({ posted_at: "2026-06-01", amount: 900, is_recurring: true }), // rent → committed
        txn({ posted_at: "2026-05-30", amount: 999 }), // other month → ignored
      ],
      Y,
      M,
      "2026-06-19",
    );
    expect(m.committed).toBe(900);
    expect(m.discretionaryTotal).toBe(451);
    expect(m.hottest).toEqual({ date: "2026-06-06", amount: 401 });
  });

  it("buckets intensity 1..5 relative to the hottest day, empty = 0", () => {
    const m = buildMonthHeatmap(
      [txn({ posted_at: "2026-06-06", amount: 400 }), txn({ posted_at: "2026-06-10", amount: 80 })],
      Y,
      M,
      "2026-06-19",
    );
    const cellFor = (date: string) => m.cells.find((c) => c.date === date)!;
    expect(cellFor("2026-06-06").intensity).toBe(5); // the max
    expect(cellFor("2026-06-10").intensity).toBe(1); // 80/400 → ceil(1) = 1
    expect(cellFor("2026-06-07").intensity).toBe(0); // no spend
    expect(cellFor("2026-06-07").amount).toBe(0);
  });

  it("pads to whole Mon-start weeks and marks future days", () => {
    const m = buildMonthHeatmap([], Y, M, "2026-06-19");
    // June 1 2026 is a Monday → no leading padding; 30 days → 35 cells (5 weeks).
    expect(m.cells.length % 7).toBe(0);
    expect(m.cells[0]).toMatchObject({ day: 1, isPadding: false });
    expect(m.cells.find((c) => c.date === "2026-06-20")!.isFuture).toBe(true);
    expect(m.cells.find((c) => c.date === "2026-06-19")!.isFuture).toBe(false);
  });

  it("computes the daily average over elapsed days only", () => {
    const m = buildMonthHeatmap(
      [txn({ posted_at: "2026-06-10", amount: 190 })],
      Y,
      M,
      "2026-06-19",
    );
    expect(m.dailyAverage).toBeCloseTo(10, 5); // 190 / 19 elapsed days
  });

  it("handles an empty month without dividing by zero", () => {
    const m = buildMonthHeatmap([], Y, M, "2026-06-19");
    expect(m.discretionaryTotal).toBe(0);
    expect(m.dailyAverage).toBe(0);
    expect(m.hottest).toBeNull();
    expect(m.cells.every((c) => c.intensity === 0)).toBe(true);
  });
});
