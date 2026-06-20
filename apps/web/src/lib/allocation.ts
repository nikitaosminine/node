// Pure allocation math for the expense allocation strip (Linear 1A-105).
//
// income − fixed − discretionary = left. Kept side-effect-free so the proportional
// segment widths and the overspend (negative "left") case are unit-testable.
//
//   [ Fixed | Discretionary | Left ]   ← widths proportional to max(income, spend)

export type AllocationKey = "fixed" | "discretionary" | "left";

export interface AllocationSegment {
  key: AllocationKey;
  amount: number;
  widthPct: number;
}

export interface Allocation {
  income: number | null;
  fixed: number;
  discretionary: number;
  /** income − fixed − discretionary, or null when income is unset. */
  left: number | null;
  /** Amount overspent past income (> 0 only when income is set and spend exceeds it). */
  overBy: number;
  isOverspent: boolean;
  /** fixed, discretionary, and left (left only when positive), widths in percent. */
  segments: AllocationSegment[];
}

function pct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 1000) / 10; // one decimal place
}

export function computeAllocation(
  income: number | null,
  fixed: number,
  discretionary: number,
): Allocation {
  const f = Math.max(0, fixed);
  const d = Math.max(0, discretionary);
  const spend = f + d;

  if (income == null) {
    const denom = Math.max(spend, 1);
    return {
      income: null,
      fixed: f,
      discretionary: d,
      left: null,
      overBy: 0,
      isOverspent: false,
      segments: [
        { key: "fixed", amount: f, widthPct: pct(f, denom) },
        { key: "discretionary", amount: d, widthPct: pct(d, denom) },
      ],
    };
  }

  const left = income - spend;
  const isOverspent = left < 0;
  // The bar spans whichever is larger: income (so positive "left" has room) or spend
  // (so an overspend visibly fills past the income mark).
  const denom = Math.max(income, spend, 1);
  const segments: AllocationSegment[] = [
    { key: "fixed", amount: f, widthPct: pct(f, denom) },
    { key: "discretionary", amount: d, widthPct: pct(d, denom) },
  ];
  if (left > 0) segments.push({ key: "left", amount: left, widthPct: pct(left, denom) });

  return {
    income,
    fixed: f,
    discretionary: d,
    left,
    overBy: isOverspent ? -left : 0,
    isOverspent,
    segments,
  };
}
