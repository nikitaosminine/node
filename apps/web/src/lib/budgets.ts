// Pure progress math for opt-in per-category budgets (Linear 1A-111).
//
// Caps are an opt-in layer on top of the always-on disposable-income model: with no cap set
// there is no progress and no badge. Side-effect-free so the ratio, over/under, and remaining
// math is unit-testable without a DOM or Supabase.

export interface BudgetProgress {
  cap: number;
  spent: number;
  /** spent / cap as a percentage; can exceed 100 when over. */
  pct: number;
  /** spent / cap clamped to 0..1 — the bar fill width. */
  ratio: number;
  isOver: boolean;
  /** cap − spent (negative when over). */
  remaining: number;
  /** max(0, spent − cap). */
  overBy: number;
}

export function budgetProgress(spent: number, cap: number): BudgetProgress {
  const s = Math.max(0, spent);
  const c = Math.max(0, cap);
  // A zero/invalid cap can't form a ratio; treat any spend against it as fully over.
  const pct = c > 0 ? Math.round((s / c) * 1000) / 10 : s > 0 ? 100 : 0;
  const ratio = c > 0 ? Math.min(1, s / c) : s > 0 ? 1 : 0;
  const remaining = c - s;
  return {
    cap: c,
    spent: s,
    pct,
    ratio,
    isOver: s > c,
    remaining,
    overBy: Math.max(0, s - c),
  };
}
