"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { endOfMonth, format, startOfMonth } from "date-fns";
import { ChevronRight, Sparkles } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { buildCategoryMix, type MixRow, type MixTxn } from "@/lib/category-mix";
import { DEFAULT_PORTFOLIO_CURRENCY, formatCurrency } from "@/lib/currency";

interface Props {
  categoryNames: Record<string, string>;
  refreshKey?: number;
}

// Ranked spending composition (Linear 1A-106): discretionary only, no deltas/trend —
// interpretation is the Node layer's job. Each row drills into its merchants.
export function CategoryMix({ categoryNames, refreshKey = 0 }: Props) {
  const currency = DEFAULT_PORTFOLIO_CURRENCY;
  const now = useMemo(() => new Date(), []);
  const monthStart = format(startOfMonth(now), "yyyy-MM-dd");
  const monthEnd = format(endOfMonth(now), "yyyy-MM-dd");

  const [txns, setTxns] = useState<MixTxn[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("expense_transactions")
      .select("merchant_name, amount, is_recurring, category_id")
      .gte("posted_at", monthStart)
      .lte("posted_at", monthEnd);
    setTxns(
      (data ?? []).map((r) => ({
        merchant_name: r.merchant_name,
        amount: Number(r.amount),
        is_recurring: r.is_recurring,
        category_id: r.category_id,
      })),
    );
  }, [monthStart, monthEnd]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const mix = useMemo(() => buildCategoryMix(txns, categoryNames), [txns, categoryNames]);

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const rowKey = (row: MixRow) => row.categoryId ?? "__uncat__";

  return (
    <div className="flex flex-col rounded-xl border border-hairline bg-surface px-5 py-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold">Category mix</h2>
        <span className="text-xs text-foreground-muted">
          <span className="font-mono tabular-nums text-foreground">
            {formatCurrency(mix.total, currency, { maximumFractionDigits: 0 })}
          </span>{" "}
          discretionary · fixed costs excluded
        </span>
      </div>

      {mix.rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-foreground-muted">
          No discretionary spending logged this month.
        </p>
      ) : (
        <ul className="flex flex-col">
          {mix.rows.map((row) => {
            const key = rowKey(row);
            const isOpen = expanded.has(key);
            const canDrill = row.merchants.length > 0;
            return (
              <li key={key} className="border-b border-hairline last:border-b-0">
                <button
                  type="button"
                  onClick={() => canDrill && toggle(key)}
                  aria-expanded={canDrill ? isOpen : undefined}
                  aria-label={`${row.name}: ${formatCurrency(row.amount, currency)}, ${row.sharePct}% of discretionary spending${canDrill ? `. ${isOpen ? "Hide" : "Show"} merchants.` : ""}`}
                  className="group flex w-full items-center gap-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                        <span className="ml-2 text-xs text-foreground-muted">{row.sharePct}%</span>
                      </span>
                    </div>
                    {/* Single flat neutral bar — length encodes amount; color carries no meaning. */}
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
                      <div
                        className="h-full rounded-full bg-foreground-muted"
                        style={{ width: `${Math.max(row.widthPct, 2)}%` }}
                      />
                    </div>
                  </div>
                </button>

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

      {/* Ambient Node caption + Ask Node hook — load-bearing here (no deltas by design).
          Agent not wired yet (1A-106), present so the affordance ships. */}
      <div className="mt-3 flex items-center justify-between gap-3 border-t border-hairline pt-3">
        <p className="min-w-0 flex-1 text-[11px] text-foreground-muted">
          Node reads your mix and flags what&apos;s shifting — coming soon.
        </p>
        <Button variant="outline" size="sm" disabled title="Coming soon">
          <Sparkles className="h-4 w-4" />
          Ask Node
        </Button>
      </div>
    </div>
  );
}
