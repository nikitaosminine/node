"use client";

import { useMemo, useState } from "react";
import { Check, ChevronRight, Lightbulb, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { RecapPlayer } from "./recap-player";
import { useRecap } from "./use-recap";

interface RecapInsightsRowProps {
  portfolioId: string;
}

export function RecapInsightsRow({ portfolioId }: RecapInsightsRowProps) {
  const { recap, loading, markSeen } = useRecap(portfolioId);
  const [open, setOpen] = useState(false);

  const ready = recap?.status === "ready" && (recap.slides?.length ?? 0) > 0;
  const isNew = ready && !recap?.seen_at;

  const { headline, subtitle, subtitleTone, slideCount } = useMemo(() => {
    if (!ready || !recap) {
      return {
        headline: "Your recap",
        subtitle: "Your first recap arrives after today's close.",
        subtitleTone: "muted" as const,
        slideCount: 0,
      };
    }
    const perf = recap.slides.find((s) => s.kind === "performance");
    const value = perf?.stat?.value ?? "";
    const periodWord = recap.type === "weekly" ? "this week" : "today";
    const tone =
      perf?.stat?.direction === "up"
        ? ("positive" as const)
        : perf?.stat?.direction === "down"
          ? ("negative" as const)
          : ("muted" as const);
    return {
      headline: recap.type === "weekly" ? "Your week, wrapped" : "Your day, wrapped",
      subtitle: value ? `${value} ${periodWord}` : `Wrapped · ${periodWord}`,
      subtitleTone: tone,
      slideCount: recap.slides.length,
    };
  }, [ready, recap]);

  const handleOpen = () => {
    if (!ready) return;
    markSeen();
    setOpen(true);
  };

  return (
    <>
      <div className="grid grid-cols-1 items-stretch gap-6 md:grid-cols-2">
        {/* Recap card (functional) */}
        <button
          type="button"
          onClick={handleOpen}
          disabled={!ready}
          className={cn(
            "group flex flex-col justify-between rounded-2xl border border-hairline bg-surface p-5 text-left transition-colors",
            ready ? "hover:bg-surface-2" : "cursor-default",
          )}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
              <Sparkles className="h-3.5 w-3.5" />
              Daily &amp; Weekly Recap
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {slideCount > 0 && (
                <div className="flex items-center gap-1">
                  {Array.from({ length: slideCount }).map((_, i) => (
                    <span key={i} className="h-1 w-3 rounded-full bg-foreground/25" />
                  ))}
                </div>
              )}
              {/* Read / unread status */}
              {ready &&
                (isNew ? (
                  <span className="rounded-full bg-foreground px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-background">
                    New
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-foreground-muted/60">
                    <Check className="h-3 w-3" />
                    Read
                  </span>
                ))}
            </div>
          </div>

          <div className="mt-6 flex flex-col gap-1">
            <h3 className="text-lg font-semibold tracking-tight text-foreground">{headline}</h3>
            <p
              className={cn(
                "text-sm",
                subtitleTone === "positive"
                  ? "text-positive"
                  : subtitleTone === "negative"
                    ? "text-negative"
                    : "text-foreground-muted",
              )}
            >
              {loading ? "Loading…" : subtitle}
            </p>
          </div>

          {ready && (
            <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-foreground-muted group-hover:text-foreground">
              Open stories
              <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </span>
          )}
        </button>

        {/* Insights card (placeholder — out of scope, see 1A-88) */}
        <div className="flex flex-col justify-between rounded-2xl border border-hairline bg-surface p-5 opacity-80">
          <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
            <Lightbulb className="h-3.5 w-3.5" />
            Actionable Insights
          </div>
          <div className="mt-6 flex flex-col gap-1">
            <h3 className="text-lg font-semibold tracking-tight text-foreground-muted">
              What to do next
            </h3>
            <p className="text-sm text-foreground-muted/70">
              Turning recaps into actions — coming soon.
            </p>
          </div>
          <span className="mt-4 inline-flex w-fit items-center rounded-full border border-hairline px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-foreground-muted/70">
            Coming soon
          </span>
        </div>
      </div>

      {recap && ready && <RecapPlayer recap={recap} open={open} onOpenChange={setOpen} />}
    </>
  );
}
