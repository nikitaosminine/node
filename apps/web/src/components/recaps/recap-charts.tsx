"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Line,
  LineChart,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import { ChartContainer } from "@/components/ui/chart";
import { type SlideChart, tokenColor } from "./types";

const EMPTY_CONFIG = {};

// Shared axis tick styling — mirrors portfolio-chart.tsx.
const TICK = { fill: "var(--foreground-muted)", fontSize: 10 } as const;

function fmtDate(value: string | number): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function fmtCompact(value: number): string {
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}

export function RecapChart({ chart, className }: { chart: SlideChart; className?: string }) {
  // Area sparkline (slide 1) and line (slide 3) share the portfolio-chart look:
  // hairline horizontal grid, muted ticks, monochrome gradient/stroke.
  if (chart.type === "sparkline" || chart.type === "line") {
    const series = chart.series[0];
    if (!series || series.points.length < 2) return null;
    const color = tokenColor(series.color);
    const data = series.points.map((p) => ({ x: p.x, y: p.y }));
    const gradientId = `recap-fill-${series.key}`;

    return (
      <ChartContainer
        config={EMPTY_CONFIG}
        className={`!aspect-auto h-full w-full ${className ?? ""}`}
      >
        <AreaChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={color} stopOpacity={0.25} />
              <stop offset="95%" stopColor={color} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--hairline)" />
          <XAxis
            dataKey="x"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={32}
            tick={TICK}
            tickFormatter={fmtDate}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            tickMargin={6}
            width={44}
            tick={TICK}
            domain={["dataMin", "dataMax"]}
            tickFormatter={fmtCompact}
          />
          <Area
            dataKey="y"
            type="natural"
            fill={`url(#${gradientId})`}
            stroke={color}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ChartContainer>
    );
  }

  // Bars (slide 2) — portfolio % vs each index %, with value labels.
  const data = chart.series.map((s) => ({
    name: s.label,
    value: Number((s.points[0]?.y ?? 0).toFixed(2)),
    color: tokenColor(s.color),
  }));
  if (data.length === 0) return null;

  return (
    <ChartContainer
      config={EMPTY_CONFIG}
      className={`!aspect-auto h-full w-full ${className ?? ""}`}
    >
      <BarChart data={data} margin={{ top: 18, right: 8, bottom: 0, left: 8 }}>
        <CartesianGrid vertical={false} stroke="var(--hairline)" />
        <XAxis
          dataKey="name"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          interval={0}
          tick={TICK}
        />
        <YAxis
          hide
          domain={[
            (dataMin: number) => Math.min(dataMin, 0) * 1.3 - 0.1,
            (dataMax: number) => Math.max(dataMax, 0) * 1.3 + 0.1,
          ]}
        />
        <ReferenceLine y={0} stroke="var(--hairline)" />
        <Bar dataKey="value" radius={4} isAnimationActive={false} minPointSize={3}>
          {data.map((d) => (
            <Cell key={d.name} fill={d.color} />
          ))}
          <LabelList
            dataKey="value"
            position="top"
            formatter={(value) => {
              const v = Number(value);
              return `${v > 0 ? "+" : ""}${v}%`;
            }}
            style={{ fill: "var(--foreground-muted)", fontSize: 10 }}
          />
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}
