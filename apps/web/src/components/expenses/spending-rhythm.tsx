"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { format, parseISO } from "date-fns";
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import { motion, useReducedMotion } from "framer-motion";
import { supabase } from "@/integrations/supabase/client";
import { HeatmapCellPanel } from "@/components/expenses/heatmap-cell-panel";
import { buildMonthHeatmap, type HeatCell, type HeatmapTxn } from "@/lib/heatmap";
import { dailyBars, quietestStretch, weeklyBuckets } from "@/lib/expense-insights";
import { DEFAULT_PORTFOLIO_CURRENCY, formatCurrency } from "@/lib/currency";

interface Props {
  categoryNames: Record<string, string>;
  refreshKey?: number;
}

type Period = "daily" | "weekly";
type Viz = "heatmap" | "bars";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const PILL_TRANSITION = { type: "spring" as const, stiffness: 420, damping: 34, mass: 0.7 };
const eur = (n: number) =>
  formatCurrency(n, DEFAULT_PORTFOLIO_CURRENCY, { maximumFractionDigits: 0 });

function heatBackground(intensity: number, isFuture: boolean): string {
  if (isFuture || intensity === 0) return "var(--heat-empty)";
  return `var(--heat-${intensity})`;
}
function heatColor(intensity: number, isFuture: boolean): string {
  if (isFuture || intensity === 0) return "var(--foreground-muted)";
  return intensity >= 4 ? "var(--heat-foreground)" : "var(--foreground)";
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  idKey,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  label: string;
  idKey: string;
}) {
  const reduce = useReducedMotion();
  const transition = reduce ? { duration: 0 } : PILL_TRANSITION;
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex h-8 items-center rounded-full border border-hairline bg-surface-2 p-0.5"
    >
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.value)}
            className={`relative h-7 rounded-full px-3 text-[11px] font-medium uppercase tracking-[0.1em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              active ? "text-background" : "text-foreground-muted hover:text-foreground"
            }`}
          >
            {active && (
              <motion.span
                layoutId={`seg-${idKey}`}
                className="pointer-events-none absolute inset-0 z-0 rounded-full bg-foreground"
                transition={transition}
              />
            )}
            <span className="relative z-10">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function StatCard({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: "negative";
}) {
  return (
    <div className="rounded-lg border border-hairline bg-surface px-3 py-2.5">
      <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-foreground-muted">
        {label}
      </div>
      <div
        className={`mt-1 font-mono text-base font-medium tabular-nums ${tone === "negative" ? "text-negative" : "text-foreground"}`}
      >
        {value}
      </div>
      {detail && <div className="mt-0.5 text-[11px] text-foreground-muted">{detail}</div>}
    </div>
  );
}

interface BarDatum {
  key: string;
  label: string;
  amount: number;
  intensity: number;
  isFuture: boolean;
}

function SpendingBars({ data }: { data: BarDatum[] }) {
  return (
    <div className="h-[316px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 4 }}>
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            interval="preserveStartEnd"
            tick={{ fontSize: 10, fill: "var(--foreground-muted)" }}
          />
          <Tooltip
            cursor={{ fill: "var(--surface-2)" }}
            contentStyle={{
              background: "var(--surface)",
              border: "1px solid var(--hairline)",
              borderRadius: 8,
              fontSize: 12,
            }}
            labelStyle={{ color: "var(--foreground-muted)" }}
            formatter={(value) => [eur(Number(value)), "Spent"]}
          />
          <Bar dataKey="amount" radius={[3, 3, 0, 0]} isAnimationActive={false}>
            {data.map((d) => (
              <Cell key={d.key} fill={heatBackground(d.intensity, d.isFuture)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// Spending rhythm (mockup realign): discretionary spend over time, with Daily/Weekly and
// Heatmap/Bars toggles and a right rail of derived stats. Reuses the pure heatmap model +
// insight helpers; clicking a day (daily heatmap) opens its transactions.
export function SpendingRhythm({ categoryNames, refreshKey = 0 }: Props) {
  const currency = DEFAULT_PORTFOLIO_CURRENCY;
  const now = useMemo(() => new Date(), []);
  const year = now.getFullYear();
  const month0 = now.getMonth();
  const today = format(now, "yyyy-MM-dd");
  const monthStart = format(new Date(year, month0, 1), "yyyy-MM-dd");
  const monthEnd = format(new Date(year, month0 + 1, 0), "yyyy-MM-dd");
  const prevStart = format(new Date(year, month0 - 1, 1), "yyyy-MM-dd");
  const prevEnd = format(new Date(year, month0, 0), "yyyy-MM-dd");

  const [txns, setTxns] = useState<HeatmapTxn[]>([]);
  const [prevTxns, setPrevTxns] = useState<HeatmapTxn[]>([]);
  const [error, setError] = useState(false);
  const [period, setPeriod] = useState<Period>("daily");
  const [viz, setViz] = useState<Viz>("heatmap");
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const mapTxns = (data: unknown[]): HeatmapTxn[] =>
    (data as HeatmapTxn[]).map((r) => ({
      id: r.id,
      posted_at: r.posted_at,
      merchant_name: r.merchant_name,
      amount: Number(r.amount),
      is_recurring: r.is_recurring,
      category_id: r.category_id,
    }));

  const load = useCallback(async () => {
    const [cur, prev] = await Promise.all([
      supabase
        .from("expense_transactions")
        .select("id, posted_at, merchant_name, amount, is_recurring, category_id")
        .gte("posted_at", monthStart)
        .lte("posted_at", monthEnd),
      supabase
        .from("expense_transactions")
        .select("id, posted_at, merchant_name, amount, is_recurring, category_id")
        .gte("posted_at", prevStart)
        .lte("posted_at", prevEnd),
    ]);
    if (cur.error) {
      setError(true);
      return;
    }
    setError(false);
    setTxns(mapTxns(cur.data ?? []));
    setPrevTxns(mapTxns(prev.error ? [] : (prev.data ?? [])));
  }, [monthStart, monthEnd, prevStart, prevEnd]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const model = useMemo(
    () => buildMonthHeatmap(txns, year, month0, today),
    [txns, year, month0, today],
  );
  // Previous month is fully elapsed → its dailyAverage uses the whole month as denominator.
  const prevModel = useMemo(() => {
    const d = prevEnd; // any date inside the previous month, past "today"
    return buildMonthHeatmap(
      prevTxns,
      Number(prevStart.slice(0, 4)),
      Number(prevStart.slice(5, 7)) - 1,
      d,
    );
  }, [prevTxns, prevStart, prevEnd]);

  const weeks = useMemo(() => weeklyBuckets(model.cells), [model]);
  const quiet = useMemo(() => quietestStretch(model.cells), [model]);

  const barData: BarDatum[] = useMemo(() => {
    if (period === "weekly") {
      return weeks.map((w) => ({
        key: w.key,
        label: w.label,
        amount: w.amount,
        intensity: w.intensity,
        isFuture: w.isFuture,
      }));
    }
    return dailyBars(model.cells).map((b) => {
      const cell = model.cells.find((c) => c.key === b.key);
      return {
        key: b.key,
        label: b.label,
        amount: b.amount,
        intensity: cell?.intensity ?? 0,
        isFuture: b.isFuture,
      };
    });
  }, [period, weeks, model]);

  const dayTxns = selectedDate ? txns.filter((t) => t.posted_at === selectedDate) : [];
  const avgDelta =
    prevModel.dailyAverage > 0
      ? `vs ${eur(prevModel.dailyAverage)} last month`
      : "vs no data last month";

  if (error) {
    return (
      <div className="rounded-xl border border-hairline bg-surface px-5 py-4">
        <h2 className="mb-1 text-sm font-semibold">Spending rhythm</h2>
        <p className="py-8 text-center text-sm text-foreground-muted">
          Couldn&apos;t load your spending rhythm.
        </p>
      </div>
    );
  }

  const showLegend = viz === "heatmap";

  return (
    <div className="rounded-xl border border-hairline bg-surface px-5 py-4">
      {/* Header + toggles */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-base font-semibold">Spending rhythm</h2>
          <p className="mt-0.5 text-xs text-foreground-muted">
            Discretionary spending
            {model.committed > 0 && <> · {eur(model.committed)} committed costs excluded</>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            idKey="period"
            label="Time period"
            value={period}
            onChange={setPeriod}
            options={[
              { value: "daily", label: "Daily" },
              { value: "weekly", label: "Weekly" },
            ]}
          />
          <Segmented
            idKey="viz"
            label="Chart type"
            value={viz}
            onChange={setViz}
            options={[
              { value: "heatmap", label: "Heatmap" },
              { value: "bars", label: "Bars" },
            ]}
          />
        </div>
      </div>

      <div className="flex flex-col gap-4 lg:flex-row">
        {/* Main viz */}
        <div className="min-w-0 flex-1">
          {viz === "bars" ? (
            <SpendingBars data={barData} />
          ) : period === "weekly" ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {weeks.map((w) => (
                <div
                  key={w.key}
                  className={`flex aspect-[2/1] flex-col justify-between rounded-md p-2.5 ${w.isFuture ? "border border-dashed border-hairline" : ""}`}
                  style={{
                    background: heatBackground(w.intensity, w.isFuture),
                    color: heatColor(w.intensity, w.isFuture),
                  }}
                >
                  <span className="text-[11px] font-medium">{w.label}</span>
                  <span className="text-right font-mono text-xs">{eur(w.amount)}</span>
                </div>
              ))}
            </div>
          ) : (
            <>
              <div className="mb-1.5 grid grid-cols-7 gap-1.5">
                {WEEKDAYS.map((w) => (
                  <div key={w} className="text-center text-[11px] text-foreground-muted">
                    {w}
                  </div>
                ))}
              </div>
              <div
                className="grid grid-cols-7 gap-1.5"
                role="group"
                aria-label="Daily discretionary spending"
              >
                {model.cells.map((cell) => {
                  if (cell.isPadding || cell.date == null) {
                    return <div key={cell.key} aria-hidden className="aspect-square" />;
                  }
                  const label = `${format(parseISO(cell.date), "d MMMM")}, ${eur(cell.amount)}`;
                  const style = {
                    background: heatBackground(cell.intensity, cell.isFuture),
                    color: heatColor(cell.intensity, cell.isFuture),
                  } as const;
                  const inner = (
                    <>
                      <span className="text-[11px] font-medium">{cell.day}</span>
                      {cell.amount > 0 && (
                        <span className="text-right font-mono text-[10px]">{eur(cell.amount)}</span>
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
            </>
          )}

          {/* Footer */}
          <div className="mt-3 flex items-center justify-between gap-3 text-[11px] text-foreground-muted">
            <span>
              {period === "daily" && viz === "heatmap"
                ? "Click any day to see its transactions"
                : ""}
            </span>
            {showLegend && (
              <span className="flex items-center gap-1.5">
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
              </span>
            )}
          </div>
        </div>

        {/* Right rail — derived stats */}
        <div className="flex shrink-0 flex-col gap-2 lg:w-52">
          <StatCard
            label="Hottest day"
            value={model.hottest ? format(parseISO(model.hottest.date), "EEE d MMM") : "—"}
            detail={model.hottest ? eur(model.hottest.amount) : "No spend yet"}
            tone={model.hottest ? "negative" : undefined}
          />
          <StatCard label="Daily average" value={eur(model.dailyAverage)} detail={avgDelta} />
          <StatCard
            label="Quietest stretch"
            value={
              quiet
                ? `${format(parseISO(quiet.startDate), "d")}–${format(parseISO(quiet.endDate), "d MMM")}`
                : "—"
            }
            detail={
              quiet ? `${eur(quiet.amount)} across ${quiet.days} days` : "Not enough days yet"
            }
          />
        </div>
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
