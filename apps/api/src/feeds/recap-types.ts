// ============================================================
// Recap types — canonical definitions (API side).
// Mirrored on the web in apps/web/src/components/recaps/types.ts.
// Keep the two in sync when changing the slide schema.
//
// Grounding model (plan §4a): the LLM produces ONLY prose
// (headline + body) per slide. Every figure — `stat`, `chart`,
// `sources` — is computed deterministically by the worker and
// attached to the slide afterward. The LLM never emits numbers
// or URLs into the structured output, so they cannot be
// hallucinated.
// ============================================================

export type RecapType = "daily" | "weekly";

// One slide per issue spec: portfolio / macro / mover / watch.
export type SlideKind = "performance" | "macro" | "mover" | "watch";

export type ChartType = "sparkline" | "bars" | "line";

export type Direction = "up" | "down" | "flat";

export interface SlideStat {
  label: string;
  value: string; // pre-formatted display string, e.g. "+2.43%"
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
  // Token name the web maps to a design-system color (e.g.
  // "accent-teal", "benchmark-amber", "positive"). Never a raw hex
  // from the LLM — the worker sets this.
  color?: string;
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
  // Multiple stats (e.g. mover slide: biggest gainer + biggest loser).
  // When present, the renderer shows these instead of `stat`.
  stats?: SlideStat[];
  chart?: SlideChart;
  // Multiple charts (e.g. mover slide: gainer sparkline + loser sparkline).
  // When present, the renderer shows a side-by-side grid of these.
  charts?: SlideChart[];
  sources?: SlideSource[];
}

// ---------------------------------------------------------------------------
// LLM structured output — prose only, keyed by slide kind. The worker
// validates against this shape (Gemini responseSchema) then merges the
// computed stat/chart/sources in by `kind`.
// ---------------------------------------------------------------------------

export interface RecapLlmSlide {
  kind: SlideKind;
  headline: string;
  body: string[];
}

export interface RecapLlmOutput {
  slides: RecapLlmSlide[];
}

// ---------------------------------------------------------------------------
// Persisted row + queue message
// ---------------------------------------------------------------------------

export type RecapStatus = "queued" | "running" | "ready" | "failed" | "skipped";

export interface RecapRow {
  id: string;
  portfolio_id: string;
  user_id: string;
  type: RecapType;
  period_start: string;
  period_end: string;
  status: RecapStatus;
  slides: SlideSpec[];
  model: string | null;
  token_usage: Record<string, unknown>;
  error: string | null;
  generated_at: string | null;
  seen_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RecapQueueMessage {
  recapId: string;
}
