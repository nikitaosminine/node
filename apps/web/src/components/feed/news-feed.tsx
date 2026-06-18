"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Newspaper, ArrowUpDown } from "lucide-react";
import { NewsCard, type NewsMatch } from "@/components/feed/news-card";
import { FeedShell } from "@/components/feed/feed-shell";
import { CategoryPills } from "@/components/feed/category-pills";
import { ExpandableSearch } from "@/components/feed/expandable-search";
import { API_BASE_URL } from "@/lib/api";

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 min

interface NewsFeedProps {
  portfolioId: string;
  limit?: number;
}

export function NewsFeed({ portfolioId, limit = 50 }: NewsFeedProps) {
  const [matches, setMatches] = useState<NewsMatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filter / sort / search state
  const [activeFilter, setActiveFilter] = useState("all");
  const [dateSort, setDateSort] = useState<"newest" | "oldest">("newest");
  const [search, setSearch] = useState("");

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

  // Build ticker → company name map from match_reason.matched_company_names
  const tickerToName = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of matches) {
      const tickers = m.match_reason.matched_tickers ?? [];
      const names = m.match_reason.matched_company_names ?? [];
      tickers.forEach((t, i) => {
        if (names[i]) map.set(t, names[i]);
      });
    }
    return map;
  }, [matches]);

  // Derive unique company tabs — id=ticker (for filtering), label=company name
  const companyTabs = useMemo(() => {
    const tickers = new Set(matches.flatMap((m) => m.match_reason.matched_tickers ?? []));
    const sorted = [...tickers].sort();
    return [
      { id: "all", label: "All" },
      ...sorted.map((t) => ({ id: t, label: tickerToName.get(t) ?? t })),
    ] as const;
  }, [matches, tickerToName]);

  // Client-side filter → search → sort
  const displayedMatches = useMemo(() => {
    let list = matches;

    if (activeFilter !== "all") {
      list = list.filter((m) => m.match_reason.matched_tickers?.includes(activeFilter));
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((m) => {
        const a = m.news_clusters.primary_article;
        return a.title.toLowerCase().includes(q) || a.source.toLowerCase().includes(q);
      });
    }

    list = [...list].sort((a, b) => {
      const ta = new Date(a.news_clusters.primary_article.published_at).getTime();
      const tb = new Date(b.news_clusters.primary_article.published_at).getTime();
      return dateSort === "newest" ? tb - ta : ta - tb;
    });

    return list;
  }, [matches, activeFilter, search, dateSort]);

  const isFiltered = activeFilter !== "all" || search.trim() !== "";
  const subtitle =
    matches.length > 0
      ? isFiltered
        ? `${displayedMatches.length} of ${matches.length} articles`
        : `${matches.length} articles`
      : undefined;

  // rightSlot: search + sort alongside the refresh button
  const rightSlot =
    matches.length > 0 ? (
      <>
        <ExpandableSearch value={search} onChange={setSearch} placeholder="Search…" />
        <button
          type="button"
          onClick={() => setDateSort((s) => (s === "newest" ? "oldest" : "newest"))}
          title={dateSort === "newest" ? "Showing newest first" : "Showing oldest first"}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-foreground-muted hover:bg-surface-2 hover:text-foreground"
        >
          <ArrowUpDown className="h-3.5 w-3.5" />
        </button>
      </>
    ) : undefined;

  // headerSlot: company filter pills only
  const headerSlot =
    matches.length > 0 ? (
      <div className="min-w-0 overflow-hidden">
        <CategoryPills
          tabs={companyTabs}
          activeTab={activeFilter}
          onChange={setActiveFilter}
          layoutId="news-filter-pill"
          ariaLabel="Filter by company"
        />
      </div>
    ) : undefined;

  if (loading) {
    return (
      <FeedShell title="Headlines" liveColor="red" loading>
        {null}
      </FeedShell>
    );
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
    <FeedShell
      title="Headlines"
      liveColor="red"
      subtitle={subtitle}
      onRefresh={() => fetchNews(true)}
      rightSlot={rightSlot}
      headerSlot={headerSlot}
    >
      {displayedMatches.length === 0 ? (
        <li className="px-4 py-8 text-center text-sm text-foreground-muted">
          No articles match your filter.
        </li>
      ) : (
        displayedMatches.map((match, i) => (
          <NewsCard key={match.news_clusters.id ?? i} match={match} />
        ))
      )}
    </FeedShell>
  );
}
