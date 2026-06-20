"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { Mic } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { NodeIcon } from "@/components/node-logo";
import { SetIncomeDialog } from "@/components/expenses/set-income-dialog";
import { computeAllocation } from "@/lib/allocation";
import { buildCategoryMix } from "@/lib/category-mix";
import { buildMonthHeatmap, type HeatmapTxn } from "@/lib/heatmap";
import { projectedTotal, weekendWeekdaySplit } from "@/lib/expense-insights";
import { DEFAULT_PORTFOLIO_CURRENCY, formatCurrency } from "@/lib/currency";

interface Props {
  userId: string;
  categoryNames: Record<string, string>;
  refreshKey?: number;
  onChanged: () => void;
}

const eur = (n: number) =>
  formatCurrency(n, DEFAULT_PORTFOLIO_CURRENCY, { maximumFractionDigits: 0 });

// Node AI section (mockup realign): the plain recap card + the ambient Node insight line +
// two derived chips + an Ask-Node stub. The insight is computed from the user's real data
// (over/left, top category, weekend ratio, month projection); the agent itself isn't wired.
export function ExpenseNodeSection({ userId, categoryNames, refreshKey = 0, onChanged }: Props) {
  const now = useMemo(() => new Date(), []);
  const year = now.getFullYear();
  const month0 = now.getMonth();
  const today = format(now, "yyyy-MM-dd");
  const monthStart = format(new Date(year, month0, 1), "yyyy-MM-dd");
  const monthEnd = format(new Date(year, month0 + 1, 0), "yyyy-MM-dd");
  const daysInMonth = new Date(year, month0 + 1, 0).getDate();

  const [txns, setTxns] = useState<HeatmapTxn[]>([]);
  const [income, setIncome] = useState<number | null>(null);
  const [incomeOpen, setIncomeOpen] = useState(false);

  const load = useCallback(async () => {
    const [txnRes, incomeRes] = await Promise.all([
      supabase
        .from("expense_transactions")
        .select("id, posted_at, merchant_name, amount, is_recurring, category_id")
        .gte("posted_at", monthStart)
        .lte("posted_at", monthEnd),
      supabase.from("expense_income").select("amount").eq("month", monthStart).maybeSingle(),
    ]);
    setTxns(
      (txnRes.data ?? []).map((r) => ({
        id: r.id,
        posted_at: r.posted_at,
        merchant_name: r.merchant_name,
        amount: Number(r.amount),
        is_recurring: r.is_recurring,
        category_id: r.category_id,
      })),
    );
    setIncome(incomeRes.data ? Number(incomeRes.data.amount) : null);
  }, [monthStart, monthEnd]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const { insight, chips } = useMemo(() => {
    let fixed = 0;
    let discretionary = 0;
    for (const t of txns) {
      if (t.posted_at > today) continue;
      if (t.is_recurring) fixed += t.amount;
      else discretionary += t.amount;
    }
    const alloc = computeAllocation(income, fixed, discretionary);
    const top = buildCategoryMix(txns, categoryNames).rows[0] ?? null;
    const model = buildMonthHeatmap(txns, year, month0, today);
    const ratio = weekendWeekdaySplit(model.cells).ratio;
    const projected = projectedTotal(model.dailyAverage, daysInMonth);

    const topClause = top
      ? ` Your biggest discretionary category is ${top.name} at ${eur(top.amount)}.`
      : "";

    let lead: { text: string; amount: string; tone: "negative" | "positive" | "muted" } | null;
    if (income == null) {
      lead = top
        ? { text: "Set your income to see how you're tracking.", amount: "", tone: "muted" }
        : null;
    } else if (alloc.isOverspent) {
      lead = { text: `You're ${eur(alloc.overBy)} over this month.`, amount: "", tone: "negative" };
    } else {
      lead = {
        text: `You've got ${eur(alloc.left ?? 0)} left this month.`,
        amount: "",
        tone: "positive",
      };
    }

    const insightText = lead
      ? `${lead.text}${topClause}`
      : top
        ? `Your biggest discretionary category is ${top.name} at ${eur(top.amount)}.`
        : "Add expenses to see where your money goes.";
    const tone = lead?.tone ?? "muted";

    const chipList: string[] = [];
    if (ratio != null && ratio > 0) {
      chipList.push(`Weekends cost ${ratio.toFixed(1)}× weekdays.`);
    }
    if (model.dailyAverage > 0) {
      if (income != null) {
        chipList.push(
          projected > income
            ? `At this pace you'll finish ~${eur(projected - income)} over by ${format(new Date(year, month0 + 1, 0), "d MMM")}.`
            : `At this pace you'll keep ~${eur(income - projected)} by ${format(new Date(year, month0 + 1, 0), "d MMM")}.`,
        );
      } else {
        chipList.push(`At this pace you'll spend ~${eur(projected)} this month.`);
      }
    }

    return { insight: { text: insightText, tone }, chips: chipList };
  }, [txns, income, categoryNames, year, month0, today, daysInMonth]);

  return (
    <div className="rounded-xl border border-hairline bg-surface p-4">
      <div className="flex flex-col gap-4 lg:flex-row">
        {/* Recap card — plain mono placeholder (agent/recap not wired). */}
        <div className="flex shrink-0 flex-col justify-between rounded-lg border border-hairline bg-surface-2 p-4 lg:w-64">
          <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-foreground-muted">
            This week, wrapped
          </div>
          <div className="mt-6">
            <div className="text-2xl font-semibold tracking-tight text-foreground-muted">
              Coming soon
            </div>
            <p className="mt-1 text-xs text-foreground-muted/70">
              A narrated rundown of your week.
            </p>
          </div>
          <div className="mt-4 flex items-center gap-1.5">
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className="h-1 w-4 rounded-full bg-foreground/15" />
            ))}
          </div>
        </div>

        {/* Node insight + chips + Ask Node */}
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-foreground">
              <NodeIcon inverse className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0">
              <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-foreground-muted">
                Node
              </div>
              <p
                className={`mt-0.5 text-sm leading-relaxed ${
                  insight.tone === "negative" ? "text-foreground" : "text-foreground"
                }`}
              >
                {insight.text}
              </p>
            </div>
          </div>

          {chips.length > 0 && (
            <div className="grid gap-2 sm:grid-cols-2">
              {chips.map((c) => (
                <div
                  key={c}
                  className="rounded-lg border border-hairline bg-surface px-3 py-2 text-xs text-foreground-muted"
                >
                  {c}
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2">
            <div className="flex flex-1 items-center gap-2 rounded-lg border border-hairline bg-surface px-3 py-2 opacity-70">
              <NodeIcon className="h-3.5 w-3.5" />
              <span className="truncate text-sm text-foreground-muted">
                Ask Node — &ldquo;Where can I cut €300?&rdquo;
              </span>
              <Mic className="ml-auto h-3.5 w-3.5 shrink-0 text-foreground-muted" />
            </div>
            {income == null ? (
              <button
                type="button"
                onClick={() => setIncomeOpen(true)}
                className="shrink-0 rounded-lg border border-hairline px-3 py-2 text-xs font-medium text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground"
              >
                Set income
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setIncomeOpen(true)}
                className="shrink-0 rounded-lg px-2 py-2 text-xs text-foreground-muted underline-offset-4 hover:text-foreground hover:underline"
              >
                income {eur(income)}
              </button>
            )}
          </div>
        </div>
      </div>

      <SetIncomeDialog
        open={incomeOpen}
        onOpenChange={setIncomeOpen}
        userId={userId}
        defaultMonth={format(now, "yyyy-MM")}
        onSaved={() => {
          void load();
          onChanged();
        }}
      />
    </div>
  );
}
