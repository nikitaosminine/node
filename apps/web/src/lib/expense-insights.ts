// Derived insights for the Spending rhythm section + the Node ambient line (mockup realign).
//
// All pure: they operate on the HeatCell[] the heatmap model already produces (per-day
// discretionary amounts, future flags, Mon-start padding) so weekly rollups, weekend/weekday
// ratios, the quietest stretch, and the month projection stay unit-testable.

import type { HeatCell } from "@/lib/heatmap";

export interface WeeklyBucket {
  key: string;
  label: string; // "Wk 1"
  amount: number;
  /** Intensity 0..5 relative to the busiest elapsed week (mirrors the daily ramp). */
  intensity: number;
  isFuture: boolean; // every day in the week is in the future
}

export interface DayBar {
  key: string;
  label: string; // day-of-month
  date: string;
  amount: number;
  isFuture: boolean;
}

function intensityFor(amount: number, max: number): number {
  if (amount <= 0) return 0;
  if (max <= 0) return 1;
  return Math.min(5, Math.max(1, Math.ceil((amount / max) * 5)));
}

/** Group the Mon-start cells into whole-week rows, summed, with an intensity ramp. */
export function weeklyBuckets(cells: HeatCell[]): WeeklyBucket[] {
  const rows: { amount: number; isFuture: boolean }[] = [];
  for (let w = 0; w * 7 < cells.length; w++) {
    const real = cells.slice(w * 7, w * 7 + 7).filter((c) => !c.isPadding);
    if (real.length === 0) continue;
    rows.push({
      amount: real.reduce((s, c) => s + c.amount, 0),
      isFuture: real.every((c) => c.isFuture),
    });
  }
  const max = Math.max(0, ...rows.filter((r) => !r.isFuture).map((r) => r.amount));
  return rows.map((r, i) => ({
    key: `wk-${i}`,
    label: `Wk ${i + 1}`,
    amount: r.amount,
    intensity: r.isFuture ? 0 : intensityFor(r.amount, max),
    isFuture: r.isFuture,
  }));
}

/** One bar per real calendar day, in order. */
export function dailyBars(cells: HeatCell[]): DayBar[] {
  return cells
    .filter((c) => !c.isPadding && c.date != null)
    .map((c) => ({
      key: c.key,
      label: String(c.day),
      date: c.date as string,
      amount: c.amount,
      isFuture: c.isFuture,
    }));
}

/** Average discretionary spend on weekend vs weekday elapsed days (column 5/6 = Sat/Sun). */
export function weekendWeekdaySplit(cells: HeatCell[]): {
  weekdayAvg: number;
  weekendAvg: number;
  ratio: number | null;
} {
  let wdSum = 0;
  let wdN = 0;
  let weSum = 0;
  let weN = 0;
  cells.forEach((c, i) => {
    if (c.isPadding || c.isFuture || c.date == null) return;
    if (i % 7 >= 5) {
      weSum += c.amount;
      weN += 1;
    } else {
      wdSum += c.amount;
      wdN += 1;
    }
  });
  const weekdayAvg = wdN ? wdSum / wdN : 0;
  const weekendAvg = weN ? weSum / weN : 0;
  return { weekdayAvg, weekendAvg, ratio: weekdayAvg > 0 ? weekendAvg / weekdayAvg : null };
}

export interface QuietestStretch {
  startDate: string;
  endDate: string;
  amount: number;
  days: number;
}

/** The consecutive elapsed-day window of `windowDays` with the least total spend. */
export function quietestStretch(cells: HeatCell[], windowDays = 2): QuietestStretch | null {
  const days = cells.filter(
    (c): c is HeatCell & { date: string } => !c.isPadding && !c.isFuture && c.date != null,
  );
  if (days.length < windowDays) return null;
  let best: QuietestStretch | null = null;
  for (let i = 0; i + windowDays <= days.length; i++) {
    const win = days.slice(i, i + windowDays);
    const amount = win.reduce((s, c) => s + c.amount, 0);
    if (!best || amount < best.amount) {
      best = {
        startDate: win[0].date,
        endDate: win[win.length - 1].date,
        amount,
        days: windowDays,
      };
    }
  }
  return best;
}

/** Straight-line projection of the month total from the elapsed daily average. */
export function projectedTotal(dailyAverage: number, daysInMonth: number): number {
  return dailyAverage * daysInMonth;
}
