"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { format, parseISO } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { HeatmapCellPanel } from "@/components/expenses/heatmap-cell-panel";
import { buildMonthHeatmap, type HeatCell, type HeatmapTxn } from "@/lib/heatmap";
import { DEFAULT_PORTFOLIO_CURRENCY, formatCurrency } from "@/lib/currency";

interface Props {
  categoryNames: Record<string, string>;
  refreshKey?: number;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function cellBackground(cell: HeatCell): string {
  if (cell.isPadding) return "transparent";
  if (cell.isFuture || cell.intensity === 0) return "var(--heat-empty)";
  return `var(--heat-${cell.intensity})`;
}

function cellColor(cell: HeatCell): string {
  if (cell.isFuture || cell.intensity === 0) return "var(--foreground-muted)";
  // White text on the two most saturated steps keeps AA contrast; dark elsewhere.
  return cell.intensity >= 4 ? "#fff" : "var(--foreground)";
}

export function SpendingHeatmap({ categoryNames, refreshKey = 0 }: Props) {
  const currency = DEFAULT_PORTFOLIO_CURRENCY;
  const now = useMemo(() => new Date(), []);
  const year = now.getFullYear();
  const month0 = now.getMonth();
  const today = format(now, "yyyy-MM-dd");
  const monthStart = format(new Date(year, month0, 1), "yyyy-MM-dd");
  const monthEnd = format(new Date(year, month0 + 1, 0), "yyyy-MM-dd");

  const [txns, setTxns] = useState<HeatmapTxn[]>([]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("expense_transactions")
      .select("id, posted_at, merchant_name, amount, is_recurring, category_id")
      .gte("posted_at", monthStart)
      .lte("posted_at", monthEnd);
    setTxns(
      (data ?? []).map((r) => ({
        id: r.id,
        posted_at: r.posted_at,
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

  const model = useMemo(
    () => buildMonthHeatmap(txns, year, month0, today),
    [txns, year, month0, today],
  );

  const caption = useMemo(() => {
    if (model.discretionaryTotal === 0) return "No discretionary spending logged yet this month.";
    const avg = `Daily average ${formatCurrency(model.dailyAverage, currency, { maximumFractionDigits: 0 })}.`;
    if (model.hottest) {
      return `Heaviest day so far: ${format(parseISO(model.hottest.date), "d MMM")} at ${formatCurrency(model.hottest.amount, currency, { maximumFractionDigits: 0 })}. ${avg}`;
    }
    return avg;
  }, [model, currency]);

  const dayTxns = selectedDate ? txns.filter((t) => t.posted_at === selectedDate) : [];

  return (
    <div className="rounded-xl border border-hairline bg-surface px-5 py-4">
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold">Spending rhythm</h2>
        {model.committed > 0 && (
          <span className="text-xs text-foreground-muted">
            <span className="font-mono tabular-nums">
              {formatCurrency(model.committed, currency, { maximumFractionDigits: 0 })}
            </span>{" "}
            committed
          </span>
        )}
      </div>
      <p className="mb-3 text-xs text-foreground-muted">{caption}</p>

      {/* Weekday header */}
      <div className="mb-1.5 grid grid-cols-7 gap-1.5">
        {WEEKDAYS.map((w) => (
          <div key={w} className="text-center text-[11px] text-foreground-muted">
            {w}
          </div>
        ))}
      </div>

      {/* Grid */}
      <div
        className="grid grid-cols-7 gap-1.5"
        role="group"
        aria-label="Daily discretionary spending"
      >
        {model.cells.map((cell) => {
          if (cell.isPadding || cell.date == null) {
            return <div key={cell.key} aria-hidden className="aspect-square" />;
          }
          const label = `${format(parseISO(cell.date), "d MMMM")}, ${formatCurrency(cell.amount, currency, { maximumFractionDigits: 0 })}`;
          const style = {
            background: cellBackground(cell),
            color: cellColor(cell),
            outlineColor: "var(--heat-5)",
          } as const;
          const inner = (
            <>
              <span className="text-[11px] font-medium">{cell.day}</span>
              {cell.amount > 0 && (
                <span className="text-right font-mono text-[10px]">
                  {formatCurrency(cell.amount, currency, { maximumFractionDigits: 0 })}
                </span>
              )}
            </>
          );
          const base =
            "flex aspect-square flex-col justify-between rounded-md p-1.5 text-left transition-shadow";
          if (cell.isFuture) {
            return (
              <div
                key={cell.key}
                aria-hidden
                className={`${base} border border-dashed border-hairline`}
                style={style}
              >
                {inner}
              </div>
            );
          }
          return (
            <button
              key={cell.key}
              type="button"
              onClick={() => setSelectedDate(cell.date)}
              aria-label={`${label}. View transactions.`}
              className={`${base} border border-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
              style={style}
            >
              {inner}
            </button>
          );
        })}
      </div>

      {/* Legend */}
      <div className="mt-3 flex items-center justify-end gap-1.5 text-[11px] text-foreground-muted">
        Less
        <span className="flex gap-1">
          {[1, 2, 3, 4, 5].map((i) => (
            <span
              key={i}
              className="h-2.5 w-3.5 rounded-sm"
              style={{ background: `var(--heat-${i})` }}
            />
          ))}
        </span>
        More
      </div>

      <HeatmapCellPanel
        open={selectedDate != null}
        onOpenChange={(o) => !o && setSelectedDate(null)}
        date={selectedDate}
        txns={dayTxns}
        categoryNames={categoryNames}
        currency={currency}
      />
    </div>
  );
}
