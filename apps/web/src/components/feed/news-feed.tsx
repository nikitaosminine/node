"use client";

import { useState, useEffect, useCallback } from "react";
import { Newspaper } from "lucide-react";
import { NewsCard, type NewsMatch } from "@/components/feed/news-card";
import { FeedShell } from "@/components/feed/feed-shell";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ??
  (process.env.NODE_ENV === "production"
    ? "https://binturong-api.nikita-osminine.workers.dev"
    : "http://localhost:8787");

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 min

interface NewsFeedProps {
  portfolioId: string;
  limit?: number;
}

export function NewsFeed({ portfolioId, limit = 20 }: NewsFeedProps) {
  const [matches, setMatches] = useState<NewsMatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchNews = useCallback(
    async (showLoadingSpinner = false) => {
      if (showLoadingSpinner) setLoading(true);
      setError(null);
      try {
        const { supabase } = await import("@/integrations/supabase/client");
        const {
          data: { session },
        } = await supabase.auth.getSession();
        const token = session?.access_token;

        const res = await fetch(
          `${API_BASE_URL}/api/feed/news?portfolio_id=${portfolioId}&limit=${limit}`,
          token ? { headers: { Authorization: `Bearer ${token}` } } : {},
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: "Unknown error" }));
          throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
        }
        const data = (await res.json()) as NewsMatch[];
        setMatches(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't load news, retrying…");
      } finally {
        setLoading(false);
      }
    },
    [portfolioId, limit],
  );

  useEffect(() => {
    fetchNews(true);
  }, [fetchNews]);

  useEffect(() => {
    const id = setInterval(() => fetchNews(false), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchNews]);

  useEffect(() => {
    const handler = () => fetchNews(false);
    window.addEventListener("focus", handler);
    return () => window.removeEventListener("focus", handler);
  }, [fetchNews]);

  const subtitle = matches.length > 0 ? `${matches.length} articles` : undefined;

  if (loading) {
    return <FeedShell title="Headlines" liveColor="red" loading>{null}</FeedShell>;
  }

  if (error) {
    return (
      <FeedShell title="Headlines" liveColor="red" onRefresh={() => fetchNews(true)}>
        <li className="px-4 py-8 text-center text-sm text-foreground-muted">{error}</li>
      </FeedShell>
    );
  }

  if (matches.length === 0) {
    return (
      <FeedShell title="Headlines" liveColor="red">
        <li className="flex flex-col items-center gap-3 px-4 py-10 text-center">
          <Newspaper className="h-8 w-8 text-foreground-muted/30" />
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium text-foreground-muted">No news yet</p>
            <p className="text-xs text-foreground-muted/70">
              News feed is personalized. Import holdings to display news.
            </p>
          </div>
        </li>
      </FeedShell>
    );
  }

  return (
    <FeedShell title="Headlines" liveColor="red" subtitle={subtitle} onRefresh={() => fetchNews(true)}>
      {matches.map((match, i) => (
        <NewsCard key={match.news_clusters.id ?? i} match={match} />
      ))}
    </FeedShell>
  );
}
