"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight, PieChart, RefreshCcw, Globe2 } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import { geoNaturalEarth1, geoPath } from "d3-geo";
import { feature } from "topojson-client";
import countriesAtlas from "world-atlas/countries-110m.json";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { InfinityLoop } from "@/components/loading-ui/infinity";
import { formatCurrency, normalizeCurrencyCode } from "@/lib/currency";
import { API_BASE_URL } from "@/lib/api";

export type AllocationDatum = { name: string; value: number };

type CountryAllocation = {
  countryCode: string;
  countryName: string;
  value: number;
  percentage: number;
  source: string;
  confidence: number;
};

type GeographyResponse = {
  countries: CountryAllocation[];
  coveragePct: number;
  unknownPct: number;
  pendingResearchCount: number;
  queuedResearchCount: number;
  runningResearchCount: number;
  failedResearchCount: number;
  completedUnknownResearchCount: number;
  failedResearchReasons?: string[];
  completedUnknownResearchReasons?: string[];
  checkedAt: string | null;
};

type Props = {
  portfolioId: string;
  sectorData: AllocationDatum[];
  assetTypeData: AllocationDatum[];
  currency: string;
  /** Lock the card to a specific view and skip fetching the other. Default: "classic" */
  initialView?: View;
  /** Hide the classic/geography toggle button. Use with initialView. */
  hideViewToggle?: boolean;
};

type View = "classic" | "geography";

const PALETTE = [
  "var(--alloc-1)",
  "var(--alloc-2)",
  "var(--alloc-3)",
  "var(--alloc-4)",
  "var(--alloc-5)",
  "var(--alloc-6)",
];

const TEXT_PALETTE = [
  "var(--alloc-1-text)",
  "var(--alloc-2-text)",
  "var(--alloc-3-text)",
  "var(--alloc-4-text)",
  "var(--alloc-5-text)",
  "var(--alloc-6-text)",
];

const MINOR_COUNTRY_THRESHOLD = 3;
const OTHER_COUNTRY_FILL = "var(--foreground-muted)";
const PILL_TRANSITION = { type: "spring" as const, stiffness: 420, damping: 34, mass: 0.7 };

const COUNTRY_CODE_TO_NUMERIC: Record<string, string> = {
  AE: "784",
  AR: "032",
  AT: "040",
  AU: "036",
  BE: "056",
  BR: "076",
  CA: "124",
  CH: "756",
  CL: "152",
  CN: "156",
  DE: "276",
  DK: "208",
  ES: "724",
  FI: "246",
  FR: "250",
  GB: "826",
  GR: "300",
  HK: "344",
  ID: "360",
  IE: "372",
  IL: "376",
  IN: "356",
  IT: "380",
  JP: "392",
  KR: "410",
  KW: "414",
  LU: "442",
  MX: "484",
  MY: "458",
  NL: "528",
  NO: "578",
  NZ: "554",
  PH: "608",
  PL: "616",
  PT: "620",
  QA: "634",
  SA: "682",
  SE: "752",
  SG: "702",
  TH: "764",
  TR: "792",
  TW: "158",
  US: "840",
  VN: "704",
  ZA: "710",
};

async function authHeaders(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
}

function fmtMoney(value: number, currency: string) {
  return formatCurrency(value, currency, {
    maximumFractionDigits: 0,
  });
}

function AllocationRows({ data, compact = false }: { data: AllocationDatum[]; compact?: boolean }) {
  const sorted = [...data].sort((a, b) => b.value - a.value);
  const total = sorted.reduce((sum, row) => sum + row.value, 0) || 1;

  return (
    <ul className={`flex min-h-0 flex-col ${compact ? "gap-2" : "gap-3"}`}>
      {sorted.map((row, index) => {
        const pct = (row.value / total) * 100;
        const fill = PALETTE[index % PALETTE.length];
        return (
          <li key={row.name} className="min-w-0">
            <div className="mb-1.5 flex items-center justify-between gap-3 text-xs">
              <span className="flex min-w-0 items-center gap-2">
                <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: fill }} />
                <span className="truncate text-foreground">{row.name}</span>
              </span>
              <span className="shrink-0 tabular-nums text-foreground-muted">{pct.toFixed(1)}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-surface-2">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.max(0.5, pct)}%`,
                  background: fill,
                }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function AssetTypeStack({ data }: { data: AllocationDatum[] }) {
  const sorted = [...data].sort((a, b) => b.value - a.value);
  const total = sorted.reduce((sum, row) => sum + row.value, 0) || 1;
  return (
    <div className="flex h-8 w-full overflow-hidden rounded-md border border-hairline bg-surface-2">
      {sorted.map((row, index) => {
        const pct = (row.value / total) * 100;
        return (
          <div
            key={row.name}
            className="flex items-center justify-center text-[10px] font-medium tabular-nums"
            style={{
              width: `${pct}%`,
              background: PALETTE[index % PALETTE.length],
              color: TEXT_PALETTE[index % TEXT_PALETTE.length],
            }}
            title={`${row.name} · ${pct.toFixed(1)}%`}
          >
            {pct >= 8 ? `${pct.toFixed(1)}%` : null}
          </div>
        );
      })}
    </div>
  );
}

function ClassicAllocation({
  sectorData,
  assetTypeData,
}: {
  sectorData: AllocationDatum[];
  assetTypeData: AllocationDatum[];
}) {
  return (
    <div className="relative min-h-0 flex-1">
      {/* The hairline splits the two halves, so it only belongs to the fixed
          50/50 layout that exists once the card is height-constrained. */}
      <div className="pointer-events-none absolute left-0 right-0 top-[calc(50%-1.5rem)] z-20 hidden border-t border-hairline @4xl:block" />
      {/* Below the two-column split the card grows with its content: no forced
          equal halves and no inner scrollers, so the page is the only scroller. */}
      <div className="flex flex-col @4xl:grid @4xl:h-full @4xl:min-h-0 @4xl:grid-rows-2">
        <section className="min-h-0 pb-5 pr-1 @4xl:overflow-y-auto">
          <div className="sticky top-0 z-10 mb-2 flex items-baseline justify-between gap-2 bg-surface pb-1">
            <div className="text-[10px] uppercase tracking-[0.12em] text-foreground-muted">
              By sector
            </div>
            <div className="text-[10px] text-foreground-muted">{sectorData.length} sectors</div>
          </div>
          <AllocationRows data={sectorData} compact />
        </section>

        <section className="min-h-0 pt-5 pr-1 @4xl:overflow-y-auto">
          <div className="sticky top-0 z-10 mb-3 flex items-baseline justify-between gap-2 bg-surface pb-1">
            <div className="text-[10px] uppercase tracking-[0.12em] text-foreground-muted">
              By asset type
            </div>
            <div className="text-[10px] text-foreground-muted">
              {assetTypeData.length} asset classes
            </div>
          </div>
          <AssetTypeStack data={assetTypeData} />
          <div className="mt-3">
            <AllocationRows data={assetTypeData} compact />
          </div>
        </section>
      </div>
    </div>
  );
}

function WorldMap({ countries }: { countries: CountryAllocation[] }) {
  const [hovered, setHovered] = useState<{
    x: number;
    y: number;
    name: string;
    percentage: number;
  } | null>(null);
  const countryByNumeric = useMemo(() => {
    const entries = countries
      .map((country) => [COUNTRY_CODE_TO_NUMERIC[country.countryCode], country] as const)
      .filter((entry): entry is [string, CountryAllocation] => Boolean(entry[0]));
    return new Map(entries);
  }, [countries]);

  const paths = useMemo(() => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const collection = feature(
      countriesAtlas as any,
      (countriesAtlas as any).objects.countries,
    ) as unknown as {
      features: Array<{ id?: string | number; properties?: { name?: string } }>;
    };
    /* eslint-enable @typescript-eslint/no-explicit-any */
    const visibleFeatures = collection.features.filter((mapFeature) => {
      const numericId = String(mapFeature.id ?? "").padStart(3, "0");
      return numericId !== "010" && mapFeature.properties?.name !== "Antarctica";
    });
    const projection = geoNaturalEarth1().fitSize([640, 220], {
      type: "FeatureCollection",
      features: visibleFeatures,
    } as never);
    const path = geoPath(projection);
    return visibleFeatures.map((mapFeature) => ({
      id: String(mapFeature.id ?? mapFeature.properties?.name ?? ""),
      name: mapFeature.properties?.name ?? "",
      d: path(mapFeature as Parameters<typeof path>[0]) ?? "",
    }));
  }, []);

  return (
    <div className="relative h-[140px] shrink-0 overflow-hidden rounded-lg border border-hairline bg-background/20 sm:h-[176px]">
      <svg
        viewBox="0 0 640 220"
        role="img"
        aria-label="Portfolio geographic allocation map"
        className="h-full w-full"
        onMouseLeave={() => setHovered(null)}
      >
        <rect width="640" height="220" fill="transparent" />
        {paths.map((pathShape) => {
          const allocation = countryByNumeric.get(pathShape.id.padStart(3, "0"));
          const intensity = allocation ? Math.min(0.95, 0.35 + allocation.percentage / 85) : 0.34;
          return (
            <path
              key={pathShape.id}
              d={pathShape.d}
              fill={allocation ? "var(--foreground)" : "var(--foreground-muted)"}
              opacity={intensity}
              stroke="var(--hairline)"
              strokeOpacity={allocation ? 0.55 : 0.32}
              strokeWidth={allocation ? 0.65 : 0.45}
              className={allocation ? "cursor-default transition-opacity" : ""}
              onMouseMove={(event) => {
                if (!allocation) return;
                const bounds = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
                setHovered({
                  x: event.clientX - (bounds?.left ?? 0),
                  y: event.clientY - (bounds?.top ?? 0),
                  name: allocation.countryName,
                  percentage: allocation.percentage,
                });
              }}
            />
          );
        })}
      </svg>
      {hovered && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border border-hairline bg-surface-elevated px-2 py-1 text-xs shadow-xl"
          style={{
            left: Math.min(520, hovered.x + 12),
            top: Math.max(8, hovered.y - 14),
          }}
        >
          <span className="text-foreground">{hovered.name}</span>
          <span className="ml-2 tabular-nums text-foreground-muted">
            {hovered.percentage.toFixed(1)}%
          </span>
        </div>
      )}
    </div>
  );
}

function GeographyAllocation({
  data,
  loading,
  onResearchPending,
  researchEnqueueing,
  currency,
}: {
  data: GeographyResponse | null;
  loading: boolean;
  onResearchPending: () => void;
  researchEnqueueing: boolean;
  currency: string;
}) {
  const countries = useMemo(() => data?.countries ?? [], [data]);
  const [otherPopoverOpen, setOtherPopoverOpen] = useState(false);
  const { majorCountries, minorCountries, otherCountry } = useMemo(() => {
    const major = countries.filter((country) => country.percentage >= MINOR_COUNTRY_THRESHOLD);
    const minor = countries.filter((country) => country.percentage < MINOR_COUNTRY_THRESHOLD);
    const other =
      minor.length > 0
        ? {
            countryCode: "OTHER",
            countryName: "Other",
            value: minor.reduce((sum, country) => sum + country.value, 0),
            percentage: minor.reduce((sum, country) => sum + country.percentage, 0),
            source: "grouped",
            confidence: Math.max(0, ...minor.map((country) => country.confidence)),
          }
        : null;
    return {
      majorCountries: major,
      minorCountries: minor.sort((a, b) => b.percentage - a.percentage),
      otherCountry: other,
    };
  }, [countries]);

  const listCountries = otherCountry ? [...majorCountries, otherCountry] : majorCountries;
  const activeResearchCount = (data?.queuedResearchCount ?? 0) + (data?.runningResearchCount ?? 0);
  const passivePendingCount = data?.pendingResearchCount ?? 0;
  const failedResearchCount = data?.failedResearchCount ?? 0;
  const completedUnknownResearchCount = data?.completedUnknownResearchCount ?? 0;
  const retryableResearchCount =
    passivePendingCount + failedResearchCount + completedUnknownResearchCount;
  const researchReasons =
    failedResearchCount > 0
      ? (data?.failedResearchReasons ?? [])
      : completedUnknownResearchCount > 0
        ? (data?.completedUnknownResearchReasons ?? [])
        : [];
  const researchNoun = (count: number) => (count === 1 ? "ETF/fund" : "ETF/fund positions");
  const researchStatus =
    data && (activeResearchCount > 0 || retryableResearchCount > 0) ? (
      <div className="mb-3 rounded-md border border-hairline bg-surface-2 px-2.5 py-2 text-[10px] text-foreground-muted">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            {activeResearchCount > 0 && <InfinityLoop className="h-4 w-6 shrink-0" />}
            <span className="truncate">
              {activeResearchCount > 0
                ? `${activeResearchCount} ${researchNoun(activeResearchCount)} research running`
                : failedResearchCount > 0
                  ? `${failedResearchCount} ${researchNoun(failedResearchCount)} research failed`
                  : completedUnknownResearchCount > 0
                    ? `${completedUnknownResearchCount} ${researchNoun(completedUnknownResearchCount)} researched, no reliable allocation`
                    : `${passivePendingCount} ${researchNoun(passivePendingCount)} research pending`}
            </span>
          </div>
          {activeResearchCount === 0 && retryableResearchCount > 0 && (
            <button
              type="button"
              onClick={onResearchPending}
              disabled={researchEnqueueing}
              className="shrink-0 rounded-full border border-hairline px-2 py-1 text-[10px] text-foreground transition-colors hover:bg-surface disabled:opacity-50"
            >
              {researchEnqueueing
                ? "Queueing..."
                : passivePendingCount > 0
                  ? "Research pending ETFs"
                  : "Retry ETF research"}
            </button>
          )}
        </div>
        {activeResearchCount === 0 && researchReasons.length > 0 && (
          <div className="mt-1 line-clamp-2 text-[10px] leading-snug text-foreground-subtle">
            {researchReasons[0]}
          </div>
        )}
      </div>
    ) : null;

  const renderCountryRow = (
    country: CountryAllocation,
    index: number,
    options: { isOther?: boolean; minorCount?: number } = {},
  ) => {
    const fill = PALETTE[index % PALETTE.length];
    return (
      <li key={country.countryCode} className="min-w-0">
        <div className="mb-1.5 flex items-center justify-between gap-3 text-xs">
          <span className="flex min-w-0 items-center gap-2">
            <span className="font-mono text-[10px] text-foreground-muted">
              {options.isOther ? "--" : country.countryCode}
            </span>
            <span className="truncate text-foreground">{country.countryName}</span>
            {options.minorCount && (
              <span className="shrink-0 text-[10px] tabular-nums text-foreground-muted">
                {options.minorCount}
              </span>
            )}
          </span>
          <span className="shrink-0 tabular-nums text-foreground-muted">
            {country.percentage.toFixed(1)}%
          </span>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
          <div className="h-2 overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.max(0.5, country.percentage)}%`,
                background: fill,
              }}
            />
          </div>
          <span className="w-16 text-right text-[10px] tabular-nums text-foreground-muted">
            {fmtMoney(country.value, currency)}
          </span>
        </div>
      </li>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <WorldMap countries={countries} />
      <div className="min-h-0 flex-1 pr-1 @4xl:overflow-y-auto">
        <div className="mb-3 flex items-center justify-between gap-3 text-[10px] text-foreground-muted">
          <span className="uppercase tracking-[0.12em]">Countries</span>
          {data && (
            <span className="tabular-nums">
              {data.coveragePct.toFixed(1)}% covered · {data.unknownPct.toFixed(1)}% unknown
            </span>
          )}
        </div>

        {loading ? (
          <div className="flex h-28 items-center justify-center gap-2 text-xs text-foreground-muted">
            <InfinityLoop className="h-6 w-8" />
            <span>Loading geography.</span>
          </div>
        ) : countries.length === 0 ? (
          <div className="flex h-28 flex-col items-stretch justify-center gap-2 text-xs text-foreground-muted">
            <span className="text-center">No cached geography yet</span>
            {researchStatus}
          </div>
        ) : (
          <>
            {researchStatus}
            <ul className="flex flex-col gap-3">
              {listCountries.map((country, index) =>
                country.countryCode === "OTHER" ? (
                  <li key="OTHER" className="min-w-0">
                    <Popover open={otherPopoverOpen} onOpenChange={setOtherPopoverOpen}>
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          className="group w-full text-left"
                          aria-label="Show small country allocations"
                        >
                          <div className="mb-1.5 flex items-center justify-between gap-3 text-xs">
                            <span className="flex min-w-0 items-center gap-2">
                              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-foreground-muted transition-colors group-hover:text-foreground" />
                              <span className="truncate text-foreground">Other</span>
                              <span className="shrink-0 text-[10px] tabular-nums text-foreground-muted">
                                {minorCountries.length}
                              </span>
                            </span>
                            <span className="shrink-0 tabular-nums text-foreground-muted">
                              {country.percentage.toFixed(1)}%
                            </span>
                          </div>
                          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
                            <div className="h-2 overflow-hidden rounded-full bg-surface-2">
                              <div
                                className="h-full rounded-full"
                                style={{
                                  width: `${Math.max(0.5, country.percentage)}%`,
                                  background: OTHER_COUNTRY_FILL,
                                }}
                              />
                            </div>
                            <span className="w-16 text-right text-[10px] tabular-nums text-foreground-muted">
                              {fmtMoney(country.value, currency)}
                            </span>
                          </div>
                        </button>
                      </PopoverTrigger>
                      <PopoverContent
                        side="right"
                        sideOffset={24}
                        className="max-h-96 w-[min(18rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-hairline bg-surface p-3 text-xs shadow-lg"
                      >
                        <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-foreground-muted">
                          Other · {minorCountries.length} countries
                        </p>
                        <div className="space-y-2">
                          {minorCountries.map((minorCountry) => (
                            <div key={minorCountry.countryCode} className="min-w-0">
                              <div className="mb-1 flex items-center justify-between gap-3">
                                <span className="flex min-w-0 items-center gap-2">
                                  <span className="font-mono text-[10px] text-foreground-muted">
                                    {minorCountry.countryCode}
                                  </span>
                                  <span className="truncate text-foreground">
                                    {minorCountry.countryName}
                                  </span>
                                </span>
                                <span className="shrink-0 tabular-nums text-foreground-muted">
                                  {minorCountry.percentage.toFixed(1)}%
                                </span>
                              </div>
                              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
                                <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                                  <div
                                    className="h-full rounded-full bg-foreground-muted"
                                    style={{ width: `${Math.max(1, minorCountry.percentage)}%` }}
                                  />
                                </div>
                                <span className="w-14 text-right text-[10px] tabular-nums text-foreground-muted">
                                  {fmtMoney(minorCountry.value, currency)}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </PopoverContent>
                    </Popover>
                  </li>
                ) : (
                  renderCountryRow(country, index)
                ),
              )}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

export function AllocationCard({
  portfolioId,
  sectorData,
  assetTypeData,
  currency,
  initialView,
  hideViewToggle,
}: Props) {
  const displayCurrency = normalizeCurrencyCode(currency);
  const [view, setView] = useState<View>(initialView ?? "classic");
  const [geography, setGeography] = useState<GeographyResponse | null>(null);
  const [geoLoading, setGeoLoading] = useState(false);
  const [geoRefreshing, setGeoRefreshing] = useState(false);
  const [geoEnqueueing, setGeoEnqueueing] = useState(false);
  const shouldReduceMotion = useReducedMotion();
  const pillTransition = shouldReduceMotion ? { duration: 0 } : PILL_TRANSITION;

  const loadGeography = useCallback(
    async (options: { quiet?: boolean } = {}) => {
      setGeoLoading(true);
      try {
        const headers = await authHeaders();
        const response = await fetch(`${API_BASE_URL}/api/portfolios/${portfolioId}/geography`, {
          headers,
          cache: "no-store",
        });
        if (!response.ok) throw new Error("Failed to load geography");
        setGeography((await response.json()) as GeographyResponse);
      } catch (error) {
        if (!options.quiet) {
          toast.error(error instanceof Error ? error.message : "Failed to load geography");
        }
      } finally {
        setGeoLoading(false);
      }
    },
    [portfolioId],
  );

  const refreshGeography = useCallback(async () => {
    setGeoRefreshing(true);
    try {
      const headers = await authHeaders();
      const response = await fetch(
        `${API_BASE_URL}/api/portfolios/${portfolioId}/geography/enqueue`,
        {
          method: "POST",
          headers,
        },
      );
      if (!response.ok) throw new Error("Failed to refresh geography");
      await loadGeography();
      toast.success("Geography refreshed and ETF research queued");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to refresh geography");
    } finally {
      setGeoRefreshing(false);
    }
  }, [loadGeography, portfolioId]);

  const enqueueGeographyResearch = useCallback(async () => {
    setGeoEnqueueing(true);
    try {
      const headers = await authHeaders();
      const response = await fetch(
        `${API_BASE_URL}/api/portfolios/${portfolioId}/geography/enqueue`,
        {
          method: "POST",
          headers,
        },
      );
      if (!response.ok) throw new Error("Failed to queue geography research");
      await loadGeography();
      toast.success("ETF geography research queued");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to queue geography research");
    } finally {
      setGeoEnqueueing(false);
    }
  }, [loadGeography, portfolioId]);

  useEffect(() => {
    if (view === "geography" && !geography && !geoLoading) {
      void loadGeography();
    }
  }, [view, geography, geoLoading, loadGeography]);

  useEffect(() => {
    const activeResearchCount =
      (geography?.queuedResearchCount ?? 0) + (geography?.runningResearchCount ?? 0);
    if (view !== "geography" || activeResearchCount === 0) return;
    const id = window.setInterval(() => {
      void loadGeography({ quiet: true });
    }, 4000);
    return () => window.clearInterval(id);
  }, [geography?.queuedResearchCount, geography?.runningResearchCount, loadGeography, view]);

  useEffect(() => {
    if (view !== "geography" || !geography) return;
    const id = window.setInterval(() => {
      void loadGeography({ quiet: true });
    }, 60_000);
    return () => window.clearInterval(id);
  }, [view, geography, loadGeography]);

  return (
    <div className="flex min-h-0 flex-col rounded-2xl border border-hairline bg-surface p-4 @4xl:h-full @4xl:overflow-hidden">
      <div className="mb-3 flex shrink-0 items-center gap-3">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-[0.12em] text-foreground-muted">
            {initialView === "geography" ? "Geography" : "Allocation"}
          </div>
          <div className="mt-0.5 truncate text-[10px] text-foreground-muted">
            {view === "classic"
              ? `${sectorData.length} sectors · ${assetTypeData.length} asset classes`
              : geography?.checkedAt
                ? `Checked ${new Date(geography.checkedAt).toLocaleDateString()}`
                : "Geography"}
          </div>
        </div>
        {view === "geography" && (
          <TooltipProvider delayDuration={150}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => void refreshGeography()}
                  disabled={geoRefreshing}
                  aria-label="Refresh geography"
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-hairline text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground disabled:opacity-50"
                >
                  <RefreshCcw className={`h-4 w-4 ${geoRefreshing ? "animate-spin" : ""}`} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-56 text-center">
                <div>Refresh equity geography from ISIN and queue ETF underlying research.</div>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
        {!hideViewToggle && (
          <div className="ml-auto flex shrink-0 items-center">
            <div className="flex h-9 gap-1 rounded-full border border-hairline bg-surface-2 p-1">
              <button
                type="button"
                onClick={() => setView("classic")}
                aria-label="Allocation by sector and asset type"
                title="Allocation by sector and asset type"
                className={`relative grid h-full w-10 place-items-center rounded-full transition-colors ${
                  view === "classic"
                    ? "text-background"
                    : "text-foreground-muted hover:text-foreground"
                } isolate`}
              >
                {view === "classic" && (
                  <motion.span
                    layoutId="allocation-view-pill"
                    className="pointer-events-none absolute inset-0 z-0 rounded-full bg-foreground"
                    transition={pillTransition}
                  />
                )}
                <PieChart className="relative z-10 h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setView("geography")}
                aria-label="Geographical allocation"
                title="Geographical allocation"
                className={`relative grid h-full w-10 place-items-center rounded-full transition-colors ${
                  view === "geography"
                    ? "text-background"
                    : "text-foreground-muted hover:text-foreground"
                } isolate`}
              >
                {view === "geography" && (
                  <motion.span
                    layoutId="allocation-view-pill"
                    className="pointer-events-none absolute inset-0 z-0 rounded-full bg-foreground"
                    transition={pillTransition}
                  />
                )}
                <Globe2 className="relative z-10 h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>

      {view === "classic" ? (
        <ClassicAllocation sectorData={sectorData} assetTypeData={assetTypeData} />
      ) : (
        <GeographyAllocation
          data={geography}
          loading={geoLoading && !geography}
          onResearchPending={() => void enqueueGeographyResearch()}
          researchEnqueueing={geoEnqueueing}
          currency={displayCurrency}
        />
      )}
    </div>
  );
}
