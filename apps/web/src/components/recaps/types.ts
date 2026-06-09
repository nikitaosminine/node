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

// One stored per-slide vote as returned by GET /api/recaps (the caller's own
// feedback). score is always 1 or -1 (the DB column is NOT NULL CHECK).
export interface SlideFeedback {
  slide_index: number;
  score: 1 | -1;
  comment: string | null;
}

// Optimistic per-slide state held by the player. score is nullable here
// because a slide may be unvoted (or have only a draft comment).
export interface SlideVote {
  score: 1 | -1 | null;
  comment: string;
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
  // LangSmith presigned feedback URL (overall signal). Null when LangSmith
  // is not configured or token generation failed.
  feedback_token: string | null;
  langsmith_run_id: string | null;
  // The caller's stored per-slide votes (empty array when none).
  slide_feedback: SlideFeedback[];
}

// Map a slide color token to a CSS custom property usable by recharts.
export function tokenColor(token: string | undefined): string {
  return token ? `var(--${token})` : "var(--foreground-muted)";
}
