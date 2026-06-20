// Pure filter + sort for the full transaction log (Linear 1A-104).
//
// The raw record: every transaction, searchable (merchant + category) and filterable by date
// range, sortable by any column. Side-effect-free so the matching, range, and comparator logic
// is unit-testable without a DOM or Supabase. The view owns fetching and presentation.

export type LogSortKey = "date" | "merchant" | "category" | "amount";
export type SortDir = "asc" | "desc";

export interface LogTxn {
  id: string;
  posted_at: string; // YYYY-MM-DD
  merchant_name: string;
  amount: number;
  currency: string;
  is_recurring: boolean;
  category_id: string | null;
}

export interface LogRange {
  from: string | null; // YYYY-MM-DD, inclusive
  to: string | null; // YYYY-MM-DD, inclusive
}

/** Quick-filter range ending today (inclusive), spanning 30 or 90 calendar days. */
export function presetRange(preset: "30D" | "90D", todayIso: string): LogRange {
  const d = new Date(`${todayIso}T00:00:00Z`);
  // Inclusive of today: a 30-day window is today plus the 29 prior days.
  d.setUTCDate(d.getUTCDate() - (preset === "30D" ? 29 : 89));
  return { from: d.toISOString().slice(0, 10), to: todayIso };
}

function categoryName(categoryId: string | null, categoryNames: Record<string, string>): string {
  return categoryId ? (categoryNames[categoryId] ?? "") : "";
}

export interface FilterSortOpts {
  search: string;
  range: LogRange;
  categoryNames: Record<string, string>;
  sortKey: LogSortKey;
  sortDir: SortDir;
}

export function filterAndSortLog(txns: LogTxn[], opts: FilterSortOpts): LogTxn[] {
  const q = opts.search.trim().toLowerCase();

  const filtered = txns.filter((t) => {
    const matchesSearch =
      !q ||
      t.merchant_name.toLowerCase().includes(q) ||
      categoryName(t.category_id, opts.categoryNames).toLowerCase().includes(q);
    const matchesFrom = !opts.range.from || t.posted_at >= opts.range.from;
    const matchesTo = !opts.range.to || t.posted_at <= opts.range.to;
    return matchesSearch && matchesFrom && matchesTo;
  });

  const dir = opts.sortDir === "asc" ? 1 : -1;
  filtered.sort((a, b) => {
    let cmp: number;
    switch (opts.sortKey) {
      case "merchant":
        cmp = a.merchant_name.localeCompare(b.merchant_name);
        break;
      case "category":
        cmp = categoryName(a.category_id, opts.categoryNames).localeCompare(
          categoryName(b.category_id, opts.categoryNames),
        );
        break;
      case "amount":
        cmp = a.amount - b.amount;
        break;
      case "date":
      default:
        cmp = a.posted_at.localeCompare(b.posted_at);
        break;
    }
    // Stable id tiebreak so equal keys keep a deterministic order across reloads.
    return (cmp || a.id.localeCompare(b.id)) * dir;
  });

  return filtered;
}
