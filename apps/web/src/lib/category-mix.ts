// Pure model for the category mix (Linear 1A-106).
//
// "What's my spending mix?" as a ranked list — DISCRETIONARY only (is_recurring === false),
// matching the heatmap's money model (fixed costs excluded). Composition only: no deltas,
// no trend — interpretation belongs to the Node layer, not the view. Each category drills
// into its merchants ("the actual places"). Side-effect-free so the ranking, share math, and
// merchant rollup are unit-testable without a DOM or Supabase.

export interface MixTxn {
  merchant_name: string;
  amount: number;
  is_recurring: boolean;
  category_id: string | null;
}

export interface MixMerchant {
  name: string;
  amount: number;
  count: number;
  /** Share of the parent category's total. */
  sharePct: number;
}

export interface MixRow {
  /** null = uncategorized (no category assigned). */
  categoryId: string | null;
  name: string;
  amount: number;
  /** Share of the discretionary total. */
  sharePct: number;
  /** Bar length relative to the largest category (the top row is always 100). */
  widthPct: number;
  count: number;
  merchants: MixMerchant[];
}

export interface CategoryMix {
  total: number;
  rows: MixRow[];
}

const UNCATEGORIZED = "Uncategorized";
const UNCATEGORIZED_KEY = "__uncat__";

function pct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 1000) / 10; // one decimal place
}

interface Group {
  amount: number;
  count: number;
  merchants: Map<string, { amount: number; count: number }>;
}

export function buildCategoryMix(
  txns: MixTxn[],
  categoryNames: Record<string, string>,
): CategoryMix {
  // Group discretionary spend by category, tracking a per-merchant breakdown for drill-down.
  const groups = new Map<string, Group>();
  let total = 0;

  for (const t of txns) {
    if (t.is_recurring) continue;
    const amount = Number(t.amount);
    if (!(amount > 0)) continue; // skip zero/negative/NaN — refunds aren't "spend mix"
    total += amount;

    const key = t.category_id ?? UNCATEGORIZED_KEY;
    let g = groups.get(key);
    if (!g) {
      g = { amount: 0, count: 0, merchants: new Map() };
      groups.set(key, g);
    }
    g.amount += amount;
    g.count += 1;

    const merchant = t.merchant_name?.trim() || "Unknown";
    const m = g.merchants.get(merchant) ?? { amount: 0, count: 0 };
    m.amount += amount;
    m.count += 1;
    g.merchants.set(merchant, m);
  }

  const maxAmount = Math.max(0, ...Array.from(groups.values(), (g) => g.amount));

  const rows: MixRow[] = Array.from(groups.entries()).map(([key, g]) => {
    const categoryId = key === UNCATEGORIZED_KEY ? null : key;
    const name = categoryId ? (categoryNames[categoryId] ?? UNCATEGORIZED) : UNCATEGORIZED;
    const merchants: MixMerchant[] = Array.from(g.merchants.entries())
      .map(([mName, m]) => ({
        name: mName,
        amount: m.amount,
        count: m.count,
        sharePct: pct(m.amount, g.amount),
      }))
      .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
    return {
      categoryId,
      name,
      amount: g.amount,
      sharePct: pct(g.amount, total),
      widthPct: pct(g.amount, maxAmount),
      count: g.count,
      merchants,
    };
  });

  // Rank by amount desc; stable name tiebreak keeps the order deterministic across reloads.
  rows.sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));

  return { total, rows };
}
