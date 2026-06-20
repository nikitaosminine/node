import { describe, it, expect } from "vitest";
import { buildMonthHeatmap, type HeatmapTxn } from "@/lib/heatmap";
import {
  dailyBars,
  projectedTotal,
  quietestStretch,
  weekendWeekdaySplit,
  weeklyBuckets,
} from "@/lib/expense-insights";

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

// June 2026 starts on a Monday, 30 days. today = 19th.
const model = buildMonthHeatmap(
  [
    txn({ posted_at: "2026-06-01", amount: 20 }), // Mon (weekday)
    txn({ posted_at: "2026-06-06", amount: 400 }), // Sat (weekend), hottest
    txn({ posted_at: "2026-06-07", amount: 80 }), // Sun (weekend)
    txn({ posted_at: "2026-06-10", amount: 50 }), // Wed (weekday)
  ],
  2026,
  5,
  "2026-06-19",
);

describe("weeklyBuckets", () => {
  it("rolls cells into whole-week rows with an intensity ramp", () => {
    const weeks = weeklyBuckets(model.cells);
    expect(weeks[0].label).toBe("Wk 1");
    expect(weeks[0].amount).toBe(500); // 20 + 400 + 80 on days 1,6,7
    expect(weeks[0].intensity).toBe(5); // busiest week
    expect(weeks[1].amount).toBe(50); // day 10
    // The last weeks are entirely after the 19th → future.
    expect(weeks.at(-1)?.isFuture).toBe(true);
  });
});

describe("dailyBars", () => {
  it("emits one bar per real day in order", () => {
    const bars = dailyBars(model.cells);
    expect(bars).toHaveLength(30);
    expect(bars[0]).toMatchObject({ label: "1", amount: 20, isFuture: false });
    expect(bars.find((b) => b.date === "2026-06-06")?.amount).toBe(400);
  });
});

describe("weekendWeekdaySplit", () => {
  it("averages weekend vs weekday elapsed days and reports the ratio", () => {
    const { weekendAvg, weekdayAvg, ratio } = weekendWeekdaySplit(model.cells);
    // Weekend elapsed days: 6,7,13,14 → (400+80)/4 = 120.
    expect(weekendAvg).toBeCloseTo(120, 5);
    // Weekday elapsed days 1..19 minus weekends = 15 days, total 70 → 70/15.
    expect(weekdayAvg).toBeCloseTo(70 / 15, 5);
    expect(ratio).toBeCloseTo(120 / (70 / 15), 4);
  });
});

describe("quietestStretch", () => {
  it("finds the lowest-spend consecutive elapsed window", () => {
    const q = quietestStretch(model.cells, 2);
    // Plenty of €0 days → a zero-total pair is the quietest.
    expect(q?.amount).toBe(0);
    expect(q?.days).toBe(2);
  });

  it("returns null when there aren't enough elapsed days", () => {
    const early = buildMonthHeatmap([], 2026, 5, "2026-06-01");
    expect(quietestStretch(early.cells, 2)).toBeNull();
  });

  it("returns null for a non-positive window instead of dereferencing an empty slice", () => {
    // Regression (CodeRabbit): windowDays <= 0 produced empty windows → win[0] crash.
    expect(quietestStretch(model.cells, 0)).toBeNull();
    expect(quietestStretch(model.cells, -1)).toBeNull();
  });
});

describe("projectedTotal", () => {
  it("extrapolates the elapsed daily average across the month", () => {
    expect(projectedTotal(model.dailyAverage, 30)).toBeCloseTo(model.dailyAverage * 30, 5);
  });
});
