// Pure model for the spending heatmap (Linear 1A-103).
//
// Intensity is computed on DISCRETIONARY spend only (is_recurring === false) — fixed costs
// carry no rhythm and would saturate the scale. Recurring spend is summed separately as the
// "committed" figure. Kept side-effect-free so the bucketing, padding, and stats are
// unit-testable without a DOM or Supabase.

export interface HeatmapTxn {
  id: string;
  posted_at: string; // YYYY-MM-DD
  merchant_name: string;
  amount: number;
  is_recurring: boolean;
  category_id: string | null;
}

export interface HeatCell {
  key: string;
  date: string | null; // null for leading/trailing padding cells
  day: number | null;
  amount: number; // discretionary spend that day
  intensity: number; // 0 = no spend (empty), 1..5 = pale → saturated
  isFuture: boolean;
  isPadding: boolean;
}

export interface HeatmapModel {
  /** Mon-start grid padded to whole weeks (length is a multiple of 7). */
  cells: HeatCell[];
  committed: number; // sum of recurring/fixed spend this month
  discretionaryTotal: number;
  dailyAverage: number; // discretionary / elapsed days in the month
  hottest: { date: string; amount: number } | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function intensityFor(amount: number, max: number): number {
  if (amount <= 0) return 0;
  if (max <= 0) return 1;
  return Math.min(5, Math.max(1, Math.ceil((amount / max) * 5)));
}

/**
 * Build the heatmap for one calendar month (month0 is 0-based). `today` (YYYY-MM-DD) marks
 * future cells and bounds the daily-average denominator.
 */
export function buildMonthHeatmap(
  txns: HeatmapTxn[],
  year: number,
  month0: number,
  today: string,
): HeatmapModel {
  const daysInMonth = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  const monthPrefix = `${year}-${pad2(month0 + 1)}`;

  const perDay = new Map<number, number>();
  let committed = 0;
  for (const t of txns) {
    if (!ISO_DATE.test(t.posted_at) || t.posted_at.slice(0, 7) !== monthPrefix) continue;
    if (t.is_recurring) {
      committed += t.amount;
      continue;
    }
    const day = Number(t.posted_at.slice(8, 10));
    perDay.set(day, (perDay.get(day) ?? 0) + t.amount);
  }

  const amounts = Array.from(perDay.values());
  const maxDay = amounts.length > 0 ? Math.max(...amounts) : 0;
  const discretionaryTotal = amounts.reduce((a, b) => a + b, 0);

  // Mon-start: convert JS Sunday-first weekday to Monday-first (Mon = 0).
  const firstWeekday = (new Date(Date.UTC(year, month0, 1)).getUTCDay() + 6) % 7;
  const cells: HeatCell[] = [];
  for (let i = 0; i < firstWeekday; i++) {
    cells.push({
      key: `pad-lead-${i}`,
      date: null,
      day: null,
      amount: 0,
      intensity: 0,
      isFuture: false,
      isPadding: true,
    });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${monthPrefix}-${pad2(d)}`;
    const amount = perDay.get(d) ?? 0;
    const isFuture = date > today;
    cells.push({
      key: date,
      date,
      day: d,
      amount,
      intensity: isFuture ? 0 : intensityFor(amount, maxDay),
      isFuture,
      isPadding: false,
    });
  }
  while (cells.length % 7 !== 0) {
    cells.push({
      key: `pad-trail-${cells.length}`,
      date: null,
      day: null,
      amount: 0,
      intensity: 0,
      isFuture: false,
      isPadding: true,
    });
  }

  // Elapsed days: through today if today is in this month, the full month if it's in the
  // past, zero if this month is entirely in the future.
  let elapsedDays: number;
  if (today.slice(0, 7) === monthPrefix)
    elapsedDays = Math.min(daysInMonth, Number(today.slice(8, 10)));
  else elapsedDays = today > `${monthPrefix}-${pad2(daysInMonth)}` ? daysInMonth : 0;
  const dailyAverage = elapsedDays > 0 ? discretionaryTotal / elapsedDays : 0;

  let hottest: { date: string; amount: number } | null = null;
  for (const [day, amount] of perDay) {
    if (amount > 0 && (!hottest || amount > hottest.amount)) {
      hottest = { date: `${monthPrefix}-${pad2(day)}`, amount };
    }
  }

  return { cells, committed, discretionaryTotal, dailyAverage, hottest };
}
