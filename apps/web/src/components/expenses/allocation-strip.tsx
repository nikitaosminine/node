"use client";

import { useCallback, useEffect, useState } from "react";
import { endOfMonth, format, startOfMonth } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { SetIncomeDialog } from "@/components/expenses/set-income-dialog";
import { computeAllocation, type Allocation, type AllocationKey } from "@/lib/allocation";
import { DEFAULT_PORTFOLIO_CURRENCY, formatCurrency } from "@/lib/currency";

interface Props {
  userId: string;
  /** Bump to force a refetch after expenses/income change. */
  refreshKey?: number;
}

const SEGMENT_BG: Record<AllocationKey, string> = {
  fixed: "bg-foreground-muted",
  discretionary: "bg-chart-2",
  left: "bg-positive",
};

const SEGMENT_LABEL: Record<AllocationKey, string> = {
  fixed: "Fixed",
  discretionary: "Discretionary",
  left: "Left",
};

export function AllocationStrip({ userId, refreshKey = 0 }: Props) {
  const currency = DEFAULT_PORTFOLIO_CURRENCY;
  const now = new Date();
  const monthStart = format(startOfMonth(now), "yyyy-MM-dd");
  const monthEnd = format(endOfMonth(now), "yyyy-MM-dd");
  const monthLabel = format(now, "MMMM");

  const [allocation, setAllocation] = useState<Allocation | null>(null);
  const [incomeOpen, setIncomeOpen] = useState(false);

  const load = useCallback(async () => {
    const [incomeRes, txnRes] = await Promise.all([
      supabase.from("expense_income").select("amount").eq("month", monthStart).maybeSingle(),
      supabase
        .from("expense_transactions")
        .select("amount, is_recurring")
        .gte("posted_at", monthStart)
        .lte("posted_at", monthEnd),
    ]);
    const income = incomeRes.data ? Number(incomeRes.data.amount) : null;
    let fixed = 0;
    let discretionary = 0;
    for (const row of txnRes.data ?? []) {
      if (row.is_recurring) fixed += Number(row.amount);
      else discretionary += Number(row.amount);
    }
    setAllocation(computeAllocation(income, fixed, discretionary));
  }, [monthStart, monthEnd]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  if (!allocation) return null;
  const { income, left, isOverspent, overBy, segments } = allocation;

  return (
    <div className="rounded-xl border border-hairline bg-surface px-5 py-4">
      {/* Header: month + income (left), what's left (right) */}
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <div className="text-sm">
          <span className="font-medium">{monthLabel}</span>
          {income != null ? (
            <button
              type="button"
              onClick={() => setIncomeOpen(true)}
              className="ml-1.5 text-foreground-muted underline-offset-4 hover:text-foreground hover:underline"
            >
              income {formatCurrency(income, currency)}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setIncomeOpen(true)}
              className="ml-1.5 text-foreground-muted underline-offset-4 hover:text-foreground hover:underline"
            >
              set income
            </button>
          )}
        </div>
        {income != null && (
          <div className="text-sm font-semibold tabular-nums">
            {isOverspent ? (
              <span className="text-negative">Over by {formatCurrency(overBy, currency)}</span>
            ) : (
              <span className="text-positive">{formatCurrency(left ?? 0, currency)} left</span>
            )}
          </div>
        )}
      </div>

      {/* Proportional bar */}
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-surface-2">
        {segments.map((seg) => (
          <div
            key={seg.key}
            className={SEGMENT_BG[seg.key]}
            style={{ width: `${seg.widthPct}%` }}
            title={`${SEGMENT_LABEL[seg.key]} ${formatCurrency(seg.amount, currency)}`}
          />
        ))}
      </div>

      {/* Legend */}
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5">
        {segments.map((seg) => (
          <div key={seg.key} className="flex items-center gap-1.5 text-xs">
            <span className={`h-2 w-2 rounded-full ${SEGMENT_BG[seg.key]}`} />
            <span className="text-foreground-muted">{SEGMENT_LABEL[seg.key]}</span>
            <span className="font-mono tabular-nums">{formatCurrency(seg.amount, currency)}</span>
          </div>
        ))}
      </div>

      <SetIncomeDialog
        open={incomeOpen}
        onOpenChange={setIncomeOpen}
        userId={userId}
        defaultMonth={format(now, "yyyy-MM")}
        onSaved={load}
      />
    </div>
  );
}
