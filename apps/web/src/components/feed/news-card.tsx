"use client";

import { useState } from "react";
import { Newspaper, ExternalLink } from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PrimaryArticle {
  title: string;
  url: string;
  source: string;
  published_at: string;
  snippet: string; // AI summary (coherent prose)
  image: string | null;
}

export interface NewsCluster {
  id: string;
  cluster_key: string;
  primary_article: PrimaryArticle;
  see_also: Array<{ title: string; url: string; source: string }>;
  entities: {
    isins: string[];
    tickers: string[];
    countries: string[];
    sectors: string[];
  };
  published_at: string;
  expires_at: string;
}

export interface NewsMatch {
  score: number;
  match_reason: {
    matched_isins?: string[];
    matched_tickers?: string[];
    matched_etfs?: string[];
    matched_country_sector?: string[];
    matched_company_names?: string[];
  };
  news_clusters: NewsCluster;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getFaviconUrl(source: string, size = 32): string {
  try {
    const cleaned = source.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
    return `https://www.google.com/s2/favicons?domain=${cleaned}&sz=${size}`;
  } catch {
    return "";
  }
}

function relativeTime(iso: string): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return "";
  }
}

function absoluteDate(iso: string): string {
  try {
    return format(new Date(iso), "d MMM yyyy");
  } catch {
    return "";
  }
}

/** Split an AI summary into clean paragraphs (summaries are coherent prose). */
function summaryParagraphs(text: string): string[] {
  return text
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// FaviconSquare — 32px favicon with newspaper fallback
// ---------------------------------------------------------------------------

function FaviconSquare({ source }: { source: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="mt-0.5 h-8 w-8 shrink-0 overflow-hidden rounded-md bg-surface-2 grid place-items-center">
      {failed ? (
        <Newspaper className="h-4 w-4 text-foreground-muted/30" />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={getFaviconUrl(source, 32)}
          alt=""
          className="h-full w-full object-contain"
          loading="lazy"
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail modal
// ---------------------------------------------------------------------------

function NewsModal({
  article,
  open,
  onClose,
}: {
  article: PrimaryArticle;
  open: boolean;
  onClose: () => void;
}) {
  const segments: string[] = article.snippet ? summaryParagraphs(article.snippet) : [];

  return (
    // Routed through ui/dialog.tsx rather than raw Radix so it inherits the shared phone
    // gutter — hand-rolled `w-full` rendered this edge-to-edge at 390. `block` undoes the
    // shared `grid gap-4` so the original margin-based rhythm is unchanged, and the surface
    // classes reproduce the previous chrome exactly. `dvh`, not `vh`: on a real phone the
    // large viewport is taller than the visible one.
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="block max-h-[90dvh] overflow-y-auto rounded-2xl border-hairline bg-surface shadow-2xl sm:rounded-2xl">
        {/* Source meta — doubles as the dialog's accessible description. */}
        <DialogDescription asChild>
          <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 pr-8 text-[11px] text-foreground-muted">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={getFaviconUrl(article.source, 16)}
              alt=""
              className="h-4 w-4 rounded-sm"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
            <span className="font-medium">{article.source}</span>
            <span className="text-foreground-muted/40">·</span>
            <span>{absoluteDate(article.published_at)}</span>
            <span className="text-foreground-muted/40">·</span>
            <span>{relativeTime(article.published_at)}</span>
          </div>
        </DialogDescription>

        {/* Title — links to article */}
        <DialogTitle asChild>
          <a
            href={article.url}
            target="_blank"
            rel="noopener noreferrer"
            className="mb-4 block break-words pr-8 text-base font-semibold leading-snug text-foreground hover:underline"
          >
            {article.title}
          </a>
        </DialogTitle>

        {/* Summary */}
        {segments.length > 0 && (
          <div className="mb-5">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-foreground-muted/60">
              Summary
            </p>
            <div className="flex flex-col gap-2">
              {segments.map((seg, i) => (
                <p key={i} className="break-words text-sm leading-relaxed text-foreground-muted">
                  {seg}
                </p>
              ))}
            </div>
          </div>
        )}

        {/* CTA */}
        <a
          href={article.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-80"
        >
          Read article
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// NewsCard — compact horizontal row, opens detail modal on click
// ---------------------------------------------------------------------------

export function NewsCard({ match }: { match: NewsMatch }) {
  const [open, setOpen] = useState(false);
  const article = match.news_clusters.primary_article;

  return (
    <>
      <li>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex w-full gap-3 px-5 py-3.5 text-left transition-colors hover:bg-surface-2/40"
        >
          {/* 32px favicon square */}
          <FaviconSquare source={article.source} />

          {/* Content */}
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            {/* Source + time (no inline favicon) */}
            <div className="flex items-center gap-1.5 text-[11px] text-foreground-muted">
              <span className="truncate font-medium">{article.source}</span>
              <span className="shrink-0 text-foreground-muted/50">·</span>
              <span className="shrink-0">{relativeTime(article.published_at)}</span>
            </div>

            {/* Title */}
            <h3 className="line-clamp-2 text-[15px] font-medium leading-snug text-foreground">
              {article.title}
            </h3>

            {/* Summary — 1 line teaser */}
            {article.snippet && (
              <p className="line-clamp-1 text-xs leading-relaxed text-foreground-muted/70">
                {article.snippet}
              </p>
            )}
          </div>

          {/* Direct-link icon (doesn't open modal) */}
          <a
            href={article.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="mt-1 shrink-0 text-foreground-muted/40 hover:text-foreground-muted"
            aria-label="Open article"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </button>
      </li>

      <NewsModal article={article} open={open} onClose={() => setOpen(false)} />
    </>
  );
}
