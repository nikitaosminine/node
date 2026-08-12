"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, ChevronRight, X } from "lucide-react";
import { useThesisContext } from "@/contexts/thesis-context";
import { motion, useReducedMotion } from "framer-motion";
import { Thesis } from "@/lib/thesis";
import { useAuth } from "@/hooks/use-auth";
import { API_BASE_URL, authHeaders } from "@/lib/api";
import { TakePageHeader } from "@/components/take/take-page-header";
import { Button } from "@/components/ui/button";
import { TakeToolbar, FilterTab } from "@/components/take/take-toolbar";
import { TakeThesisCard } from "@/components/take/take-thesis-card";
import { TakeInsightCard } from "@/components/take/take-insight-card";
import { TakeKpiSummary } from "@/components/take/take-kpi-summary";
import {
  BUCKET_ORDER,
  DateBucket,
  InsightStatus,
  TakeInsight,
  bucketFor,
  insightFromTheses,
  rankScore,
  signalsFor,
} from "@/components/take/take-feed";

const FILTER_TABS: { value: FilterTab; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "playing-out", label: "Playing out" },
  { value: "invalidated", label: "Invalidated" },
  { value: "closed", label: "Closed" },
];

const FEED_FILTERS: ("All" | InsightStatus)[] = [
  "All",
  "At risk",
  "Supportive",
  "Watch",
  "Neutral",
];

type PeriodFilter = "All" | "Last week" | "Last month";
const PERIOD_FILTERS: PeriodFilter[] = ["All", "Last week", "Last month"];

type SortOrder = "desc" | "asc";
const PILL_TRANSITION = { type: "spring" as const, stiffness: 420, damping: 34, mass: 0.7 };

export default function ThesesPage() {
  const { theses, openDrawer, openModal } = useThesisContext();
  const { user } = useAuth();
  const [filter, setFilter] = useState<FilterTab>("all");
  const [search, setSearch] = useState("");
  const [feedFilter, setFeedFilter] = useState<"All" | InsightStatus>("All");
  const [sourceFilter, setSourceFilter] = useState<"all" | "agent" | "market">("all");
  const [periodFilter, setPeriodFilter] = useState<PeriodFilter>("All");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [collapsedBuckets, setCollapsedBuckets] = useState<Set<string>>(new Set());
  const [selectedThesis, setSelectedThesis] = useState<string | null>(null);
  const [selectedInsight, setSelectedInsight] = useState<string | null>(null);
  const [agentInsights, setAgentInsights] = useState<TakeInsight[]>([]);
  const shouldReduceMotion = useReducedMotion();
  const pillTransition = shouldReduceMotion ? { duration: 0 } : PILL_TRANSITION;

  useEffect(() => {
    if (!user?.id) return;
    void (async () => {
      const response = await fetch(`${API_BASE_URL}/api/agent/feed?limit=50`, {
        headers: await authHeaders(),
      });
      if (!response.ok) return;
      const payload = (await response.json()) as {
        insights?: Array<{
          id: string;
          thesis_id: string;
          status: InsightStatus;
          headline: string;
          body: string;
          created_at: string;
          confidence?: number;
          delta_summary?: string | null;
          questions_for_user?: string[];
          evidence_ids?: string[];
        }>;
      };
      const mapped = (payload.insights ?? []).map((insight) => {
        const thesis = theses.find((item) => item.id === insight.thesis_id);
        const createdAt = new Date(insight.created_at).getTime();
        const hoursAgo = Number.isFinite(createdAt)
          ? Math.max(0, (Date.now() - createdAt) / (1000 * 60 * 60))
          : 0;
        return {
          id: `agent:${insight.id}`,
          thesisId: insight.thesis_id,
          ticker: thesis?.tickers[0] ?? "N/A",
          status: insight.status,
          source: "agent" as const,
          confidence: insight.confidence ?? null,
          headline: insight.headline,
          body: insight.body,
          deltaSummary: insight.delta_summary ?? null,
          questionsForUser: insight.questions_for_user ?? [],
          evidenceIds: insight.evidence_ids ?? [],
          hoursAgo,
          unread: hoursAgo < 24,
        };
      });
      setAgentInsights(mapped);
    })();
  }, [user?.id, theses]);

  const insights = useMemo(
    () => [...agentInsights, ...insightFromTheses(theses)].sort((a, b) => a.hoursAgo - b.hoursAgo),
    [agentInsights, theses],
  );

  const visibleInsights = useMemo(() => {
    let list = insights.filter((insight) => !dismissed.has(insight.id));

    if (feedFilter !== "All") {
      list = list.filter((insight) => insight.status === feedFilter);
    }
    if (sourceFilter !== "all") {
      list = list.filter((insight) => insight.source === sourceFilter);
    }

    if (selectedThesis) {
      list = list.filter((insight) => insight.thesisId === selectedThesis);
    }

    if (periodFilter === "Last week") {
      list = list.filter((insight) => insight.hoursAgo <= 168);
    } else if (periodFilter === "Last month") {
      list = list.filter((insight) => insight.hoursAgo <= 720);
    }

    return list.sort((a, b) =>
      sortOrder === "desc" ? a.hoursAgo - b.hoursAgo : b.hoursAgo - a.hoursAgo,
    );
  }, [dismissed, feedFilter, insights, periodFilter, selectedThesis, sortOrder, sourceFilter]);

  const groupedInsights = useMemo(() => {
    const map = new Map<DateBucket, typeof visibleInsights>();
    for (const insight of visibleInsights) {
      const bucket = bucketFor(insight.hoursAgo);
      if (!map.has(bucket)) map.set(bucket, []);
      map.get(bucket)!.push(insight);
    }

    return BUCKET_ORDER.filter((bucket) => map.has(bucket)).map(
      (bucket) => [bucket, map.get(bucket)!] as const,
    );
  }, [visibleInsights]);

  const filteredTheses = useMemo(() => {
    let list = filter === "all" ? theses : theses.filter((thesis) => thesis.status === filter);

    if (search.trim()) {
      const query = search.toLowerCase();
      list = list.filter(
        (thesis) =>
          thesis.title.toLowerCase().includes(query) ||
          thesis.summary.toLowerCase().includes(query) ||
          thesis.tickers.some((ticker) => ticker.toLowerCase().includes(query)) ||
          thesis.tags.some((tag) => tag.toLowerCase().includes(query)),
      );
    }

    return list;
  }, [filter, search, theses]);

  const highlightedThesis = useMemo(() => {
    if (!selectedInsight) return null;
    return insights.find((insight) => insight.id === selectedInsight)?.thesisId ?? null;
  }, [insights, selectedInsight]);

  const selectedThesisObj = selectedThesis
    ? theses.find((thesis) => thesis.id === selectedThesis)
    : null;

  const feedRef = useRef<HTMLDivElement>(null);
  const bucketRefs = useRef<Map<DateBucket, HTMLDivElement | null>>(new Map());

  // Fixed height (not min-height): the panes below rely on overflow-hidden for their own internal
  // scrolling. Below md the shell adds a 56px sticky top bar, so subtract it.
  return (
    <div className="flex h-[calc(100dvh-3.5rem)] flex-col overflow-hidden bg-background text-foreground md:h-screen">
      <div className="flex min-h-0 flex-1 flex-col px-6 pt-4">
        <div className="flex min-h-0 flex-1 flex-col gap-4">
          <div className="grid shrink-0 grid-cols-1 items-end border-b border-hairline pb-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <div className="space-y-4">
              <TakePageHeader />
              <div className="flex justify-end">
                <Button size="sm" onClick={() => openModal()}>
                  <Plus className="h-3.5 w-3.5 mr-1.5" />
                  New take
                </Button>
              </div>
            </div>
            <div className="hidden xl:block" />
          </div>

          <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 pb-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <section className="overflow-y-auto rounded-xl border border-border/50 bg-card p-4">
              <TakeKpiSummary
                theses={theses}
                insights={insights}
                onJumpToAtRisk={() => {
                  setFeedFilter("At risk");
                  setSelectedThesis(null);
                }}
              />

              <TakeToolbar
                tabs={FILTER_TABS}
                selectedFilter={filter}
                onFilterChange={setFilter}
                search={search}
                onSearchChange={setSearch}
              />

              <div className="mt-3 flex flex-col gap-2">
                {filteredTheses.map((thesis) => (
                  <TakeThesisCard
                    key={thesis.id}
                    thesis={thesis}
                    signals={signalsFor(thesis.id, insights)}
                    selected={selectedThesis === thesis.id}
                    highlighted={highlightedThesis === thesis.id}
                    onOpen={() => {
                      setSelectedThesis((prev) => (prev === thesis.id ? null : thesis.id));
                      openDrawer(thesis.id);
                      setSelectedInsight(null);
                    }}
                  />
                ))}
              </div>
            </section>

            <section className="flex min-h-0 flex-col overflow-y-auto rounded-xl border border-border/50 bg-card p-5">
              <div className="mb-4 flex items-start justify-between">
                <div>
                  <h2 className="text-lg font-semibold">Trace feed</h2>
                  <p className="text-xs text-muted-foreground">
                    Signals mapped to your theses — review and act with context.
                  </p>
                </div>
                <span className="inline-flex w-20 shrink-0 justify-center rounded-md border border-border/50 bg-muted px-2 py-1 font-mono text-[11px] tabular-nums text-muted-foreground">
                  Live · {visibleInsights.length}
                </span>
              </div>

              {selectedThesisObj && (
                <div className="mb-3 flex items-center gap-2 rounded-md border border-foreground/20 bg-foreground/10 px-3 py-1.5 text-xs">
                  <span className="text-foreground">Scoped to:</span>
                  <span className="font-medium">{selectedThesisObj.title}</span>
                  <button
                    onClick={() => setSelectedThesis(null)}
                    className="ml-auto flex items-center gap-1 text-foreground hover:opacity-80"
                    aria-label="Clear scope"
                  >
                    <X className="h-3 w-3" />
                    Clear
                  </button>
                </div>
              )}

              <div className="mb-3 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
                <div className="flex min-w-0 flex-wrap items-center gap-3">
                  {/* Sentiment */}
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] uppercase tracking-wider text-foreground-muted">
                      Sentiment
                    </span>
                    <div className="flex gap-px rounded-full border border-hairline bg-surface-2 p-0.5">
                      {FEED_FILTERS.map((status) => (
                        <button
                          key={status}
                          onClick={() => setFeedFilter(status)}
                          className={`relative rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
                            feedFilter === status
                              ? ""
                              : "text-foreground-muted hover:text-foreground"
                          } isolate`}
                        >
                          {feedFilter === status && (
                            <motion.span
                              layoutId="take-feed-sentiment-pill"
                              className="pointer-events-none absolute inset-0 z-0 rounded-full bg-foreground"
                              transition={pillTransition}
                            />
                          )}
                          <span
                            className={`relative z-10 transition-colors duration-75 ${
                              feedFilter === status
                                ? "delay-100 text-background"
                                : "text-foreground-muted"
                            }`}
                          >
                            {status}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Source */}
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] uppercase tracking-wider text-foreground-muted">
                      Source
                    </span>
                    <div className="flex gap-px rounded-full border border-hairline bg-surface-2 p-0.5">
                      {(["all", "agent", "market"] as const).map((source) => (
                        <button
                          key={source}
                          onClick={() => setSourceFilter(source)}
                          className={`relative rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
                            sourceFilter === source
                              ? ""
                              : "text-foreground-muted hover:text-foreground"
                          } isolate`}
                        >
                          {sourceFilter === source && (
                            <motion.span
                              layoutId="take-feed-source-pill"
                              className="pointer-events-none absolute inset-0 z-0 rounded-full bg-foreground"
                              transition={pillTransition}
                            />
                          )}
                          <span
                            className={`relative z-10 transition-colors duration-75 ${
                              sourceFilter === source
                                ? "delay-100 text-background"
                                : "text-foreground-muted"
                            }`}
                          >
                            {source === "all" ? "All" : source === "agent" ? "Agent" : "Market"}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Period */}
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] uppercase tracking-wider text-foreground-muted">
                      Period
                    </span>
                    <div className="flex gap-px rounded-full border border-hairline bg-surface-2 p-0.5">
                      {PERIOD_FILTERS.map((period) => (
                        <button
                          key={period}
                          onClick={() => setPeriodFilter(period)}
                          className={`relative rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
                            periodFilter === period
                              ? ""
                              : "text-foreground-muted hover:text-foreground"
                          } isolate`}
                        >
                          {periodFilter === period && (
                            <motion.span
                              layoutId="take-feed-period-pill"
                              className="pointer-events-none absolute inset-0 z-0 rounded-full bg-foreground"
                              transition={pillTransition}
                            />
                          )}
                          <span
                            className={`relative z-10 transition-colors duration-75 ${
                              periodFilter === period
                                ? "delay-100 text-background"
                                : "text-foreground-muted"
                            }`}
                          >
                            {period}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Sort order */}
                <div className="relative flex shrink-0 gap-px rounded-full border border-hairline bg-surface-2 p-0.5">
                  <motion.span
                    className="pointer-events-none absolute inset-y-0.5 left-0.5 z-0 w-16 rounded-full bg-foreground"
                    animate={{ x: sortOrder === "desc" ? 0 : 65 }}
                    transition={pillTransition}
                  />
                  <button
                    onClick={() => setSortOrder("desc")}
                    className={`relative w-16 rounded-full py-0.5 text-[11px] font-medium transition-colors ${
                      sortOrder === "desc" ? "" : "text-foreground-muted hover:text-foreground"
                    } isolate`}
                    title="Newest first"
                  >
                    <span
                      className={`relative z-10 transition-colors duration-75 ${
                        sortOrder === "desc" ? "delay-100 text-background" : "text-foreground-muted"
                      }`}
                    >
                      ↓ Newest
                    </span>
                  </button>
                  <button
                    onClick={() => setSortOrder("asc")}
                    className={`relative w-16 rounded-full py-0.5 text-[11px] font-medium transition-colors ${
                      sortOrder === "asc" ? "" : "text-foreground-muted hover:text-foreground"
                    } isolate`}
                    title="Oldest first"
                  >
                    <span
                      className={`relative z-10 transition-colors duration-75 ${
                        sortOrder === "asc" ? "delay-100 text-background" : "text-foreground-muted"
                      }`}
                    >
                      ↑ Oldest
                    </span>
                  </button>
                </div>
              </div>

              <div ref={feedRef} className="take-scrollbar flex flex-col gap-2 pr-1">
                {groupedInsights.length === 0 && (
                  <div className="rounded-lg border border-dashed border-border/50 p-8 text-center text-xs text-muted-foreground">
                    No insights match this filter.
                  </div>
                )}

                {groupedInsights.map(([bucket, items]) => {
                  const collapsed = collapsedBuckets.has(bucket);
                  return (
                    <div
                      key={bucket}
                      ref={(el) => {
                        bucketRefs.current.set(bucket, el);
                      }}
                      className="flex flex-col gap-2"
                    >
                      <button
                        onClick={() =>
                          setCollapsedBuckets((prev) => {
                            const next = new Set(prev);
                            if (next.has(bucket)) {
                              next.delete(bucket);
                            } else {
                              next.add(bucket);
                            }
                            return next;
                          })
                        }
                        className="sticky top-0 z-10 -mx-1 flex items-center gap-2 bg-card/95 px-1 py-1 text-left backdrop-blur hover:text-foreground"
                        aria-expanded={!collapsed}
                        aria-label={`${collapsed ? "Expand" : "Collapse"} ${bucket}`}
                      >
                        <ChevronRight
                          className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${collapsed ? "" : "rotate-90"}`}
                        />
                        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                          {bucket}
                        </h3>
                        <span className="text-[10px] text-muted-foreground">· {items.length}</span>
                        <div className="ml-2 h-px flex-1 bg-border/50" />
                      </button>

                      {!collapsed &&
                        items.map((insight) => (
                          <TakeInsightCard
                            key={insight.id}
                            insight={insight}
                            thesis={theses.find((thesis) => thesis.id === insight.thesisId)}
                            selected={selectedInsight === insight.id}
                            onSelect={() =>
                              setSelectedInsight((prev) =>
                                prev === insight.id ? null : insight.id,
                              )
                            }
                            onDismiss={() => setDismissed((prev) => new Set(prev).add(insight.id))}
                            onThesisClick={() => {
                              setSelectedThesis((prev) =>
                                prev === insight.thesisId ? null : insight.thesisId,
                              );
                            }}
                          />
                        ))}
                    </div>
                  );
                })}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
