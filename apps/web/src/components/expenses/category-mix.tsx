"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { endOfMonth, format, startOfMonth } from "date-fns";
import { ChevronRight, Sparkles } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { CategoryCapControl } from "@/components/expenses/category-cap-control";
import { buildCategoryMix, type MixRow, type MixTxn } from "@/lib/category-mix";
import { budgetProgress } from "@/lib/budgets";
import { DEFAULT_PORTFOLIO_CURRENCY, formatCurrency } from "@/lib/currency";

interface Props {
  userId: string;
  categoryNames: Record<string, string>;
  /** Month to read (first of month). Defaults to the current month. */
  monthDate?: Date;
  refreshKey?: number;
  /** Drop the card chrome + title + Node footer when rendered inside the breakdown tabs. */
  embedded?: boolean;
  /** Reports the discretionary total so an embedding header can show it. */
  onTotal?: (total: number) => void;
}

// Ranked spending composition (Linear 1A-106): discretionary only, no deltas/trend —
// interpretation is the Node layer's job. Each row drills into its merchants. Per-category
// budget caps (1A-111) are an opt-in layer — surfaced only on rows where a cap is set.
export function CategoryMix({
  userId,
  categoryNames,
  monthDate,
  refreshKey = 0,
  embedded = false,
  onTotal,
}: Props) {
  const currency = DEFAULT_PORTFOLIO_CURRENCY;
  const monthStart = format(startOfMonth(monthDate ?? new Date()), "yyyy-MM-dd");
  const monthEnd = format(endOfMonth(monthDate ?? new Date()), "yyyy-MM-dd");

  const [txns, setTxns] = useState<MixTxn[]>([]);
  const [caps, setCaps] = useState<Record<string, number>>({});
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    const [txnRes, budgetRes] = await Promise.all([
      supabase
        .from("expense_transactions")
        .select("merchant_name, amount, is_recurring, category_id")
        .gte("posted_at", monthStart)
        .lte("posted_at", monthEnd),
      supabase.from("expense_budgets").select("category_id, amount").eq("period", "monthly"),
    ]);
    // A failed spend query must not collapse into the success-looking "no spending" empty
    // state. Caps are optional — a budget-fetch failure just leaves the calm, capless default.
    if (txnRes.error) {
      setError(true);
      return;
    }
    setError(false);
    setTxns(
      (txnRes.data ?? []).map((r) => ({
        merchant_name: r.merchant_name,
        amount: Number(r.amount),
        is_recurring: r.is_recurring,
        category_id: r.category_id,
      })),
    );
    const capMap: Record<string, number> = {};
    for (const b of budgetRes.data ?? []) {
      if (b.category_id) capMap[b.category_id] = Number(b.amount);
    }
    setCaps(capMap);
  }, [monthStart, monthEnd]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const mix = useMemo(() => buildCategoryMix(txns, categoryNames), [txns, categoryNames]);

  useEffect(() => {
    onTotal?.(mix.total);
  }, [mix.total, onTotal]);

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const rowKey = (row: MixRow) => row.categoryId ?? "__uncat__";

  return (
    <div
      className={
        embedded
          ? "flex flex-col"
          : "flex flex-col rounded-xl border border-hairline bg-surface px-5 py-4"
      }
    >
      {!embedded && (
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold">Category mix</h2>
          <span className="text-xs text-foreground-muted">
            <span className="font-mono tabular-nums text-foreground">
              {formatCurrency(mix.total, currency, { maximumFractionDigits: 0 })}
            </span>{" "}
            discretionary · fixed costs excluded
          </span>
        </div>
      )}

      {error ? (
        <p className="py-8 text-center text-sm text-foreground-muted">
          Couldn&apos;t load your category mix.
        </p>
      ) : mix.rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-foreground-muted">
          No discretionary spending logged this month.
        </p>
      ) : (
        <ul className="flex flex-col">
          {mix.rows.map((row) => {
            const key = rowKey(row);
            const isOpen = expanded.has(key);
            const canDrill = row.merchants.length > 0;
            const cap = row.categoryId ? (caps[row.categoryId] ?? null) : null;
            const prog = cap != null ? budgetProgress(row.amount, cap) : null;
            return (
              <li key={key} className="border-b border-hairline last:border-b-0">
                <div className="group/row flex items-center gap-2 py-2.5">
                  <button
                    type="button"
                    onClick={() => canDrill && toggle(key)}
                    aria-expanded={canDrill ? isOpen : undefined}
                    aria-label={`${row.name}: ${formatCurrency(row.amount, currency)}, ${row.sharePct}% of discretionary spending${canDrill ? `. ${isOpen ? "Hide" : "Show"} merchants.` : ""}`}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <ChevronRight
                      aria-hidden
                      className={`h-3.5 w-3.5 shrink-0 text-foreground-muted transition-transform ${
                        isOpen ? "rotate-90" : ""
                      } ${canDrill ? "" : "opacity-0"}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="mb-1.5 flex items-baseline justify-between gap-3">
                        <span className="truncate text-sm font-medium">{row.name}</span>
                        <span className="shrink-0 font-mono text-sm tabular-nums">
                          {formatCurrency(row.amount, currency, { maximumFractionDigits: 0 })}
                          <span className="ml-2 text-xs text-foreground-muted">
                            {row.sharePct}%
                          </span>
                        </span>
                      </div>
                      {/* No cap: flat neutral bar, length = share of the largest category.
                          Capped (opt-in): the bar becomes spend-vs-cap progress, red over. */}
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
                        <div
                          className={`h-full rounded-full ${prog?.isOver ? "bg-negative" : "bg-foreground-muted"}`}
                          style={{
                            width: `${Math.max(prog ? prog.ratio * 100 : row.widthPct, 2)}%`,
                          }}
                        />
                      </div>
                    </div>
                  </button>

                  {/* Opt-in cap control — quiet "Set cap" until a cap exists, then a badge. */}
                  {row.categoryId && (
                    <CategoryCapControl
                      userId={userId}
                      categoryId={row.categoryId}
                      categoryName={row.name}
                      spent={row.amount}
                      cap={cap}
                      currency={currency}
                      onChange={load}
                    />
                  )}
                </div>

                {isOpen && canDrill && (
                  <ul className="mb-2 ml-[1.625rem] flex flex-col gap-1.5 border-l border-hairline pl-3">
                    {row.merchants.map((m) => (
                      <li
                        key={m.name}
                        className="flex items-baseline justify-between gap-3 text-xs"
                      >
                        <span className="min-w-0 truncate text-foreground-muted">
                          {m.name}
                          {m.count > 1 && (
                            <span className="ml-1.5 text-[11px] opacity-70">×{m.count}</span>
                          )}
                        </span>
                        <span className="shrink-0 font-mono tabular-nums">
                          {formatCurrency(m.amount, currency, { maximumFractionDigits: 0 })}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* Ambient Node caption + Ask Node hook — only when standalone; inside the breakdown
          tabs the Node section at the top of the page owns this affordance. */}
      {!embedded && (
        <div className="mt-3 flex items-center justify-between gap-3 border-t border-hairline pt-3">
          <p className="min-w-0 flex-1 text-[11px] text-foreground-muted">
            Node reads your mix and flags what&apos;s shifting — coming soon.
          </p>
          <Button variant="outline" size="sm" disabled title="Coming soon">
            <Sparkles className="h-4 w-4" />
            Ask Node
          </Button>
        </div>
      )}
    </div>
  );
}
