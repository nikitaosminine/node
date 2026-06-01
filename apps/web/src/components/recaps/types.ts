// Recap slide types — mirror of apps/api/src/feeds/recap-types.ts.
// Keep in sync when the slide schema changes.

export type RecapType = "daily" | "weekly";
export type SlideKind = "performance" | "macro" | "mover" | "watch";
export type ChartType = "sparkline" | "bars" | "line";
export type Direction = "up" | "down" | "flat";

export interface SlideStat {
  label: string;
  value: string;
  delta?: string;
  direction?: Direction;
}

export interface ChartSeriesPoint {
  x: string | number;
  y: number;
}

export interface ChartSeries {
  key: string;
  label: string;
  color?: string; // design-system token name, e.g. "accent-teal"
  points: ChartSeriesPoint[];
}

export interface SlideChart {
  type: ChartType;
  series: ChartSeries[];
}

export interface SlideSource {
  title: string;
  url: string;
  source: string;
}

export interface SlideSpec {
  schema_version: 1;
  kind: SlideKind;
  headline: string;
  body: string[];
  stat?: SlideStat;
  stats?: SlideStat[];
  chart?: SlideChart;
  charts?: SlideChart[];
  sources?: SlideSource[];
}

export interface Recap {
  id: string;
  type: RecapType;
  period_start: string;
  period_end: string;
  status: "queued" | "running" | "ready" | "failed" | "skipped";
  slides: SlideSpec[];
  generated_at: string | null;
  seen_at: string | null;
}

// Map a slide color token to a CSS custom property usable by recharts.
export function tokenColor(token: string | undefined): string {
  return token ? `var(--${token})` : "var(--foreground-muted)";
}
