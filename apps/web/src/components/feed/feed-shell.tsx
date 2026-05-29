"use client";

import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

interface FeedShellProps {
  title: string;
  /** Pulsating dot colour + "LIVE · …" badge */
  liveColor?: "red" | "green";
  /** Badge text after "LIVE · " — defaults to News (red) / Markets (green) */
  liveLabel?: string;
  /** Small subtitle below the title, e.g. "8 articles" or "4 markets tracked" */
  subtitle?: string;
  onRefresh?: () => void;
  /** Optional slot below the title row (e.g. category pills for Polymarket) */
  headerSlot?: React.ReactNode;
  /** Show skeleton rows instead of children while loading */
  loading?: boolean;
  children: React.ReactNode;
  className?: string;
}

function SkeletonRow() {
  return (
    <li className="flex gap-3 px-5 py-3.5">
      <div className="h-14 w-14 shrink-0 animate-pulse rounded-md bg-surface-2" />
      <div className="flex flex-1 flex-col gap-2 py-0.5">
        <div className="h-2.5 w-24 animate-pulse rounded-full bg-surface-2" />
        <div className="h-3.5 w-full animate-pulse rounded-full bg-surface-2" />
        <div className="h-3.5 w-3/4 animate-pulse rounded-full bg-surface-2" />
        <div className="h-2.5 w-1/2 animate-pulse rounded-full bg-surface-2" />
      </div>
    </li>
  );
}

export function FeedShell({
  title,
  liveColor,
  liveLabel,
  subtitle,
  onRefresh,
  headerSlot,
  loading = false,
  children,
  className,
}: FeedShellProps) {
  const badgeText = liveLabel ?? (liveColor === "red" ? "News" : "Markets");
  return (
    <section
      className={cn(
        "flex flex-col overflow-hidden rounded-2xl border border-hairline bg-surface",
        className,
      )}
    >
      {/* Header */}
      <header className="flex shrink-0 flex-col gap-2 border-b border-hairline px-5 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-0.5">
            {/* LIVE · NEWS / LIVE · MARKETS pulsating badge */}
            {liveColor && (
              <div className="flex items-center gap-1.5">
                <span className="relative flex h-1.5 w-1.5">
                  <span
                    className={cn(
                      "absolute inline-flex h-full w-full animate-ping rounded-full opacity-75",
                      liveColor === "red" ? "bg-red-400" : "bg-emerald-400",
                    )}
                  />
                  <span
                    className={cn(
                      "relative inline-flex h-1.5 w-1.5 rounded-full",
                      liveColor === "red" ? "bg-red-500" : "bg-emerald-500",
                    )}
                  />
                </span>
                <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-foreground-muted">
                  Live · {badgeText}
                </span>
              </div>
            )}

            {/* Large display title */}
            <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>

            {/* Subtitle */}
            {subtitle && (
              <p className="text-[13px] text-foreground-muted">{subtitle}</p>
            )}
          </div>

          {/* Refresh button */}
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              className="mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-md text-foreground-muted hover:bg-surface-2 hover:text-foreground"
              title="Refresh"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Pills row (Polymarket category pills) */}
        {headerSlot && <div className="min-w-0">{headerSlot}</div>}
      </header>

      {/* Body */}
      <div className="max-h-[680px] flex-1 overflow-y-auto">
        <ul className="flex flex-col divide-y divide-border/30">
          {loading ? (
            <>
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
            </>
          ) : (
            children
          )}
        </ul>
      </div>
    </section>
  );
}
