"use client";

import { Lightbulb, Sparkles } from "lucide-react";

// Plain-mono recap teaser (Linear 1A-110): the mockup's Instagram-style "Wrapped" stories
// modal becomes a calm placeholder, mirroring the portfolio recap row's coming-soon cards.
// No gradient, no agent wiring yet — just the affordance.
export function ExpenseRecapTeaser() {
  return (
    <div className="grid grid-cols-1 items-stretch gap-6 md:grid-cols-2">
      <div className="flex flex-col justify-between rounded-xl border border-hairline bg-surface p-5">
        <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5" />
          Monthly recap
        </div>
        <div className="mt-6 flex flex-col gap-1">
          <h3 className="text-lg font-semibold tracking-tight text-foreground-muted">
            Your month, wrapped
          </h3>
          <p className="text-sm text-foreground-muted/70">
            A narrated rundown of where your money went this month — coming soon.
          </p>
        </div>
        <span className="mt-4 inline-flex w-fit items-center rounded-full border border-hairline px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-foreground-muted/70">
          Coming soon
        </span>
      </div>

      <div className="flex flex-col justify-between rounded-xl border border-hairline bg-surface p-5">
        <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
          <Lightbulb className="h-3.5 w-3.5" />
          Spending insights
        </div>
        <div className="mt-6 flex flex-col gap-1">
          <h3 className="text-lg font-semibold tracking-tight text-foreground-muted">
            What to change next
          </h3>
          <p className="text-sm text-foreground-muted/70">
            Node spots what&apos;s drifting and what to trim — coming soon.
          </p>
        </div>
        <span className="mt-4 inline-flex w-fit items-center rounded-full border border-hairline px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-foreground-muted/70">
          Coming soon
        </span>
      </div>
    </div>
  );
}
