"use client";

import { Newspaper } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

// ---------------------------------------------------------------------------
// Types (unchanged — consumed by news-feed.tsx)
// ---------------------------------------------------------------------------

interface PrimaryArticle {
  title: string;
  url: string;
  source: string;
  published_at: string;
  snippet: string;
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
  };
  news_clusters: NewsCluster;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getFaviconUrl(source: string): string {
  try {
    const cleaned = source.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
    return `https://www.google.com/s2/favicons?domain=${cleaned}&sz=16`;
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

/** Derive a short "via" label from the match_reason for display */
function matchLabel(reason: NewsMatch["match_reason"]): string | null {
  if (reason.matched_etfs?.length) return `via ${reason.matched_etfs[0]}`;
  if (reason.matched_tickers?.length) return null; // direct match — no label needed
  if (reason.matched_isins?.length) return null;
  return null;
}

// ---------------------------------------------------------------------------
// NewsCard — compact horizontal row, fits inside FeedShell <ul>
// ---------------------------------------------------------------------------

export function NewsCard({ match }: { match: NewsMatch }) {
  const article = match.news_clusters.primary_article;
  const via = matchLabel(match.match_reason);

  return (
    <li>
      <a
        href={article.url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex w-full gap-3 px-5 py-3.5 transition-colors hover:bg-surface-2/40"
      >
        {/* Square thumbnail — ~1/10 of the column width */}
        <div className="h-14 w-14 shrink-0 overflow-hidden rounded-md bg-surface-2">
          {article.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={article.image}
              alt=""
              className="h-full w-full object-cover"
              loading="lazy"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
                const parent = e.currentTarget.parentElement;
                if (parent) parent.classList.add("grid", "place-items-center");
              }}
            />
          ) : (
            <div className="grid h-full w-full place-items-center">
              <Newspaper className="h-5 w-5 text-foreground-muted/40" />
            </div>
          )}
        </div>

        {/* Content */}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {/* Source + time */}
          <div className="flex items-center gap-1.5 text-[11px] text-foreground-muted">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={getFaviconUrl(article.source)}
              alt=""
              className="h-3 w-3 rounded-sm opacity-70"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
            <span className="truncate font-medium">{article.source}</span>
            <span className="shrink-0 text-foreground-muted/50">·</span>
            <span className="shrink-0">{relativeTime(article.published_at)}</span>
          </div>

          {/* Title */}
          <h3 className="line-clamp-2 text-[15px] font-medium leading-snug text-foreground">
            {article.title}
          </h3>

          {/* Snippet */}
          {article.snippet && (
            <p className="line-clamp-1 text-xs leading-relaxed text-foreground-muted/80">
              {article.snippet}
            </p>
          )}

          {/* ETF via-label */}
          {via && (
            <p className="line-clamp-1 text-[11px] italic text-foreground-muted/60">{via}</p>
          )}
        </div>
      </a>
    </li>
  );
}
