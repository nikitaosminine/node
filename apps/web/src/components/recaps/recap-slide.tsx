"use client";

import { ArrowUpRight, ThumbsDown, ThumbsUp } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";
import { RecapChart } from "./recap-charts";
import type { SlideKind, SlideSpec, SlideStat, SlideVote } from "./types";

const KIND_EYEBROW: Record<SlideKind, string> = {
  performance: "Your portfolio",
  macro: "The macro story",
  mover: "Biggest movers",
  watch: "Watch out for",
};

function toneClass(direction: string | undefined): string {
  if (direction === "up") return "text-positive";
  if (direction === "down") return "text-negative";
  return "text-foreground";
}

function StatRow({ stat, size }: { stat: SlideStat; size: "lg" | "sm" }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="truncate text-[11px] text-foreground-muted">{stat.label}</span>
      <span
        className={cn(
          "font-mono font-medium tabular-nums",
          size === "lg" ? "text-2xl" : "text-lg",
          toneClass(stat.direction),
        )}
      >
        {stat.value}
      </span>
    </div>
  );
}

export interface RecapSlideFeedbackHandlers {
  vote: SlideVote;
  onVote: (score: 1 | -1) => void;
  onCommentChange: (value: string) => void;
  onCommentFocus: () => void;
  onCommentBlur: () => void;
}

// "Help us improve" row: thumbs + comment. Sits below the sources footer.
// Monochrome only — selected = filled icon + subtle surface pill (no
// green/red; those are reserved for financial direction).
function SlideFeedbackRow({
  vote,
  onVote,
  onCommentChange,
  onCommentFocus,
  onCommentBlur,
}: RecapSlideFeedbackHandlers) {
  const reduceMotion = useReducedMotion();

  return (
    <div className="flex flex-col gap-2 border-t border-hairline pt-3">
      <p className="text-[11px] text-foreground-muted">Help us improve</p>
      <div className="flex items-center gap-2">
        <motion.button
          type="button"
          aria-label="Thumbs up"
          aria-pressed={vote.score === 1}
          whileTap={reduceMotion ? undefined : { scale: 0.85 }}
          onClick={() => onVote(1)}
          className={cn(
            "flex h-8 w-8 shrink-0 touch-manipulation items-center justify-center rounded-full transition-colors",
            vote.score === 1
              ? "bg-surface-2 text-foreground"
              : "text-foreground-muted/50 hover:text-foreground-muted",
          )}
        >
          <ThumbsUp className={cn("h-4 w-4", vote.score === 1 && "fill-current")} />
        </motion.button>
        <motion.button
          type="button"
          aria-label="Thumbs down"
          aria-pressed={vote.score === -1}
          whileTap={reduceMotion ? undefined : { scale: 0.85 }}
          onClick={() => onVote(-1)}
          className={cn(
            "flex h-8 w-8 shrink-0 touch-manipulation items-center justify-center rounded-full transition-colors",
            vote.score === -1
              ? "bg-surface-2 text-foreground"
              : "text-foreground-muted/50 hover:text-foreground-muted",
          )}
        >
          <ThumbsDown className={cn("h-4 w-4", vote.score === -1 && "fill-current")} />
        </motion.button>
        <input
          type="text"
          value={vote.comment}
          onChange={(e) => onCommentChange(e.target.value)}
          onFocus={onCommentFocus}
          onBlur={onCommentBlur}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
          placeholder="Add a comment…"
          maxLength={2000}
          className="min-h-[32px] flex-1 rounded-md border-0 bg-surface-2 px-3 text-[13px] text-foreground placeholder:text-foreground-muted/60 focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>
    </div>
  );
}

export function RecapSlide({
  slide,
  feedback,
}: {
  slide: SlideSpec;
  feedback: RecapSlideFeedbackHandlers;
}) {
  const hasStats = slide.stats && slide.stats.length > 0;
  const hasCharts = slide.charts && slide.charts.length > 0;

  return (
    <div className="flex h-full flex-col gap-5 px-7 pb-7 pt-14">
      <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
        {KIND_EYEBROW[slide.kind]}
      </p>

      <h2 className="text-xl font-semibold leading-tight tracking-tight text-foreground">
        {slide.headline}
      </h2>

      {/* Single stat (performance) or multi-stat row (mover: gainer + loser) */}
      {slide.stat && !hasStats && <StatRow stat={slide.stat} size="lg" />}
      {hasStats && (
        <div className="flex gap-8">
          {slide.stats!.slice(0, 2).map((s, i) => (
            <StatRow key={i} stat={s} size="sm" />
          ))}
        </div>
      )}

      {/* Single chart (performance sparkline, macro bars) */}
      {slide.chart && !hasCharts && (
        <div className="h-[180px] w-full shrink-0">
          <RecapChart chart={slide.chart} />
        </div>
      )}

      {/* Two charts side-by-side (mover: gainer + loser sparklines) */}
      {hasCharts && (
        <div className="grid grid-cols-2 gap-3">
          {slide.charts!.map((c, i) => (
            <div key={i} className="h-[120px] w-full shrink-0">
              <RecapChart chart={c} />
            </div>
          ))}
        </div>
      )}

      {slide.body.length > 0 && (
        <div className="flex flex-col gap-2">
          {slide.body.map((line, i) => (
            <p key={i} className="text-[14px] leading-relaxed text-foreground-muted">
              {line}
            </p>
          ))}
        </div>
      )}

      {/* Spacer keeps content top-aligned; sources pin to the bottom. */}
      <div className="flex-1" />

      {slide.sources && slide.sources.length > 0 && (
        <div className="flex flex-col gap-1.5 border-t border-hairline pt-3">
          {slide.sources.slice(0, 3).map((s, i) => (
            <a
              key={i}
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex items-center gap-1.5 text-[12px] text-foreground-muted hover:text-foreground"
            >
              <span className="truncate">{s.title}</span>
              <ArrowUpRight className="h-3 w-3 shrink-0 opacity-50 group-hover:opacity-100" />
              {s.source && <span className="shrink-0 text-foreground-muted/60">· {s.source}</span>}
            </a>
          ))}
        </div>
      )}

      <SlideFeedbackRow {...feedback} />
    </div>
  );
}
