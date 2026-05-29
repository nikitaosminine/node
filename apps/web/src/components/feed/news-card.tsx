"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, ExternalLink } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

interface SeeAlsoItem {
  title: string;
  url: string;
  source: string;
}

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
  see_also: SeeAlsoItem[];
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
    matched_country_sector?: string[];
  };
  news_clusters: NewsCluster;
}

function getFaviconUrl(source: string): string {
  // Best-effort: use a known favicon service
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

export function NewsCard({ match }: { match: NewsMatch }) {
  const [expanded, setExpanded] = useState(false);
  const article = match.news_clusters.primary_article;
  const seeAlso = match.news_clusters.see_also ?? [];
  const hasImage = !!article.image;

  return (
    <article className="group flex flex-col gap-0 overflow-hidden rounded-xl border border-border/50 bg-card transition-shadow hover:shadow-sm">
      {/* Thumbnail */}
      {hasImage && (
        <div className="relative h-36 w-full overflow-hidden bg-surface-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={article.image!}
            alt=""
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
            loading="lazy"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
        </div>
      )}

      <div className="flex flex-col gap-2 p-3.5">
        {/* Source + time */}
        <div className="flex items-center gap-1.5 text-xs text-foreground-muted">
          {article.source && (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={getFaviconUrl(article.source)}
                alt=""
                className="h-3.5 w-3.5 rounded-sm opacity-70"
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = "none";
                }}
              />
              <span className="font-medium">{article.source}</span>
              <span className="text-foreground-muted/50">·</span>
            </>
          )}
          <span>{relativeTime(article.published_at)}</span>
        </div>

        {/* Title */}
        <a
          href={article.url}
          target="_blank"
          rel="noopener noreferrer"
          className="line-clamp-3 text-sm font-semibold leading-snug text-foreground hover:underline"
        >
          {article.title}
        </a>

        {/* Snippet */}
        {article.snippet && (
          <p className="line-clamp-2 text-xs leading-relaxed text-foreground-muted">
            {article.snippet}
          </p>
        )}

        {/* See also */}
        {seeAlso.length > 0 && (
          <div className="mt-0.5">
            <button
              type="button"
              onClick={() => setExpanded((e) => !e)}
              className="flex items-center gap-1 text-xs font-medium text-foreground-muted hover:text-foreground"
            >
              {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              {expanded ? "Hide" : `See also (${seeAlso.length})`}
            </button>
            {expanded && (
              <ul className="mt-2 flex flex-col gap-1.5 border-t border-hairline pt-2">
                {seeAlso.map((item, i) => (
                  <li key={i} className="flex items-start gap-1.5">
                    <ExternalLink className="mt-0.5 h-3 w-3 shrink-0 text-foreground-muted/60" />
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="line-clamp-2 text-xs text-foreground-muted hover:text-foreground hover:underline"
                    >
                      <span className="font-medium">{item.source && `${item.source}: `}</span>
                      {item.title}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
