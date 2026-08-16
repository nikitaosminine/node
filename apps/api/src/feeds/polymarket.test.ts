import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { dbFrom } = vi.hoisted(() => ({ dbFrom: vi.fn() }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ from: dbFrom })),
}));

import {
  NON_FINANCIAL_RE,
  TAG_IDS,
  buildPortfolioProfile,
  enqueueEtfConstituentsEnrichment,
  fetchCandidateMarkets,
  invokePolymarketGrok,
  isNearCertainMarket,
  isShortTermMarket,
  runPolymarketFanout,
  shouldUsePolymarketCurationCache,
  upsertThenPrunePortfolioMatches,
} from "./polymarket";

const env = {
  SUPABASE_URL: "https://supabase.example",
  SUPABASE_SERVICE_KEY: "service-key",
  POLYMARKET_GAMMA_BASE_URL: "https://gamma.example",
};

function gammaEvent(conditionId = "0xmarket", eventId = "event-1", eventSlug = "fed-rates-2026") {
  return {
    id: eventId,
    slug: eventSlug,
    title: "Fed rates in 2026?",
    image: null,
    tags: [{ id: 120, label: "Finance" }],
    markets: [
      {
        conditionId,
        slug: "fed-rates-market",
        question: "Will the Fed cut rates in 2026?",
        outcomes: '["Yes","No"]',
        outcomePrices: '["0.55","0.45"]',
        liquidity: 1000,
        volume24hr: 500,
        startDate: "2026-01-01T00:00:00Z",
        endDate: "2026-12-31T00:00:00Z",
        active: true,
      },
    ],
  };
}

async function holdingsHash(holding: {
  ticker: string;
  isin: string | null;
  quantity: number;
}): Promise<string> {
  const fingerprint = `${holding.ticker}|${holding.isin ?? ""}|${Math.round(holding.quantity * 100)}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fingerprint));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

beforeEach(() => {
  dbFrom.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("isShortTermMarket", () => {
  it("flags markets spanning less than 14 days", () => {
    expect(isShortTermMarket("2026-01-01T00:00:00Z", "2026-01-05T00:00:00Z")).toBe(true);
  });

  it("keeps markets spanning 14 days or more", () => {
    expect(isShortTermMarket("2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z")).toBe(false);
  });

  it("keeps markets with unknown duration (missing start/end)", () => {
    expect(isShortTermMarket(null, "2026-02-01T00:00:00Z")).toBe(false);
    expect(isShortTermMarket("2026-01-01T00:00:00Z", null)).toBe(false);
  });
});

describe("isNearCertainMarket", () => {
  it("flags markets with a leading outcome >= 0.97", () => {
    expect(isNearCertainMarket([0.98, 0.02])).toBe(true);
    expect(isNearCertainMarket([0.97, 0.03])).toBe(true);
  });

  it("keeps markets with no near-certain outcome", () => {
    expect(isNearCertainMarket([0.55, 0.45])).toBe(false);
  });

  it("keeps markets with missing outcome prices", () => {
    expect(isNearCertainMarket(null)).toBe(false);
    expect(isNearCertainMarket([])).toBe(false);
  });
});

describe("category endpoint filter application", () => {
  // Mirrors the filter chain applied post-query in the
  // GET /api/polymarket/category handler in index.ts.
  function applyCategoryFilters(
    markets: Array<{
      question: string;
      start_date: string | null;
      end_date: string | null;
      outcome_prices: number[];
    }>,
  ) {
    return markets
      .filter((m) => !NON_FINANCIAL_RE.test(m.question ?? ""))
      .filter((m) => !isShortTermMarket(m.start_date, m.end_date))
      .filter((m) => !isNearCertainMarket(m.outcome_prices));
  }

  it("drops short-duration, near-certain, and non-financial markets while keeping normal ones", () => {
    const markets = [
      {
        question: "Will MSFT close $440-$450 this week?",
        start_date: "2026-01-01T00:00:00Z",
        end_date: "2026-01-05T00:00:00Z",
        outcome_prices: [0.5, 0.5],
      },
      {
        question: "Will the Fed cut rates in 2026?",
        start_date: "2026-01-01T00:00:00Z",
        end_date: "2026-12-31T00:00:00Z",
        outcome_prices: [0.99, 0.01],
      },
      {
        question: "Will the Super Bowl champion be decided by field goal?",
        start_date: "2026-01-01T00:00:00Z",
        end_date: "2026-12-31T00:00:00Z",
        outcome_prices: [0.5, 0.5],
      },
      {
        question: "Will EWY close above $60 in May?",
        start_date: "2026-01-01T00:00:00Z",
        end_date: "2026-02-01T00:00:00Z",
        outcome_prices: [0.6, 0.4],
      },
    ];

    const filtered = applyCategoryFilters(markets);

    expect(filtered.map((m) => m.question)).toEqual(["Will EWY close above $60 in May?"]);
  });
});

describe("fetchCandidateMarkets", () => {
  it("uses Gamma's camelCase volume24hr order field and returns live markets", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        requestedUrls.push(String(input));
        return new Response(JSON.stringify([gammaEvent()]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const markets = await fetchCandidateMarkets(env);

    expect(markets.size).toBe(1);
    expect(requestedUrls).toHaveLength(Object.keys(TAG_IDS).length);
    for (const requestedUrl of requestedUrls) {
      const url = new URL(requestedUrl);
      expect(url.searchParams.get("order")).toBe("volume24hr");
      expect(url.searchParams.get("active")).toBe("true");
      expect(url.searchParams.get("closed")).toBe("false");
    }
  });

  it("rejects a completely failed candidate refresh before any database access", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ type: "validation error", error: "order fields are not valid" }),
            {
              status: 422,
              headers: { "Content-Type": "application/json" },
            },
          ),
      ),
    );

    await expect(runPolymarketFanout(env)).rejects.toThrow("Gamma candidate pool is empty");
    expect(dbFrom).not.toHaveBeenCalled();
  });
});

describe("stale market deactivation", () => {
  it("deactivates resolved and un-refetched markets on every fanout run", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([gammaEvent()]), { status: 200 })),
    );

    let updatePayload: unknown;
    let eqArgs: unknown[] = [];
    let orFilter = "";

    dbFrom.mockImplementation((table: string) => {
      if (table === "polymarket_markets") {
        return {
          upsert: vi.fn().mockResolvedValue({ error: null }),
          update: vi.fn((payload: unknown) => {
            updatePayload = payload;
            return {
              eq: vi.fn((...args: unknown[]) => {
                eqArgs = args;
                return {
                  or: vi.fn((filter: string) => {
                    orFilter = filter;
                    return {
                      select: vi.fn().mockResolvedValue({
                        data: [{ condition_id: "0xresolved" }, { condition_id: "0xabandoned" }],
                        error: null,
                      }),
                    };
                  }),
                };
              }),
            };
          }),
        };
      }
      if (table === "portfolios") {
        return { select: vi.fn().mockResolvedValue({ data: [], error: null }) };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const result = await runPolymarketFanout(env);

    expect(updatePayload).toEqual({ active: false });
    expect(eqArgs).toEqual(["active", true]);
    expect(orFilter).toContain("end_date.lt.");
    expect(orFilter).toContain("fetched_at.lt.");
    expect(result.marketsDeactivated).toBe(2);
  });

  it("propagates a deactivation failure instead of silently continuing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([gammaEvent()]), { status: 200 })),
    );

    dbFrom.mockImplementation((table: string) => {
      if (table === "polymarket_markets") {
        return {
          upsert: vi.fn().mockResolvedValue({ error: null }),
          update: vi.fn(() => ({
            eq: vi.fn(() => ({
              or: vi.fn(() => ({
                select: vi.fn().mockResolvedValue({
                  data: null,
                  error: { message: "connection reset" },
                }),
              })),
            })),
          })),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    await expect(runPolymarketFanout(env)).rejects.toThrow(
      "failed to deactivate stale markets: connection reset",
    );
  });
});

describe("Polymarket Grok curation", () => {
  it("sends Grok 4.6 with medium reasoning by default", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "[]" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      invokePolymarketGrok(
        { ...env, GROK_MAIN_API_KEY: "grok-key" },
        "system prompt",
        "user prompt",
      ),
    ).resolves.toBe("[]");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.x.ai/v1/chat/completions");
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "grok-4.6",
      reasoning_effort: "medium",
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "user prompt" },
      ],
    });
  });

  it("rejects an unsupported reasoning effort before calling Grok", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      invokePolymarketGrok(
        {
          ...env,
          GROK_MAIN_API_KEY: "grok-key",
          POLYMARKET_GROK_REASONING_EFFORT: "none",
        },
        "system prompt",
        "user prompt",
      ),
    ).rejects.toThrow("Invalid POLYMARKET_GROK_REASONING_EFFORT");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bypasses an otherwise-valid holdings cache when forceRescore is true", () => {
    const nowMs = Date.parse("2026-08-16T10:00:00Z");
    const cacheRow = {
      holdings_hash: "same-hash",
      last_scored_at: "2026-08-16T09:00:00Z",
      profile_text: "Direct holdings: AAPL",
    };

    expect(
      shouldUsePolymarketCurationCache({
        cacheRow,
        currentHash: "same-hash",
        forceRescore: false,
        nowMs,
      }),
    ).toBe(true);
    expect(
      shouldUsePolymarketCurationCache({
        cacheRow,
        currentHash: "same-hash",
        forceRescore: true,
        nowMs,
      }),
    ).toBe(false);
  });

  it("counts every Grok attempt, including an empty-result fallback", async () => {
    const holding = {
      ticker: "AAPL",
      isin: null,
      asset_type: "stock",
      name: "Apple",
      quantity: 1,
    };
    const currentHash = await holdingsHash(holding);
    const matchUpserts: unknown[][] = [];
    const cacheUpsert = vi.fn().mockResolvedValue({ error: null });

    dbFrom.mockImplementation((table: string) => {
      if (table === "polymarket_markets") {
        return {
          upsert: vi.fn().mockResolvedValue({ error: null }),
          update: vi.fn(() => ({
            eq: vi.fn(() => ({
              or: vi.fn(() => ({
                select: vi.fn().mockResolvedValue({ data: [], error: null }),
              })),
            })),
          })),
        };
      }
      if (table === "portfolios") {
        return {
          select: vi.fn().mockResolvedValue({
            data: [
              { id: "portfolio-1", user_id: "user-1" },
              { id: "portfolio-2", user_id: "user-2" },
            ],
            error: null,
          }),
        };
      }
      if (table === "portfolio_polymarket_matches") {
        return {
          upsert: vi.fn(async (rows: unknown[]) => {
            matchUpserts.push(rows);
            return { error: null };
          }),
          delete: vi.fn(() => ({
            eq: vi.fn(() => ({
              not: vi.fn().mockResolvedValue({ error: null }),
            })),
          })),
        };
      }
      if (table === "holdings") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              gt: vi.fn().mockResolvedValue({ data: [holding], error: null }),
            })),
          })),
        };
      }
      if (table === "portfolio_holdings_cache") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn().mockResolvedValue({
                data: {
                  holdings_hash: currentHash,
                  last_scored_at: new Date().toISOString(),
                  profile_text: "Direct holdings: AAPL",
                },
                error: null,
              }),
            })),
          })),
          upsert: cacheUpsert,
        };
      }
      if (table === "holding_geography_allocations") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              order: vi.fn(() => ({
                limit: vi.fn().mockResolvedValue({ data: [], error: null }),
              })),
            })),
          })),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const xaiRequests: Array<{ model: string; reasoning_effort: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "https://api.x.ai/v1/chat/completions") {
          xaiRequests.push(JSON.parse(String(init?.body)));
          const content =
            xaiRequests.length === 1
              ? JSON.stringify([
                  {
                    condition_id: "0xrotating",
                    score: 0.91,
                    reason: "Rate changes affect AAPL valuation",
                  },
                ])
              : "[]";
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: { content },
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify([gammaEvent("0xrotating")]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const result = await runPolymarketFanout(
      { ...env, GROK_MAIN_API_KEY: "grok-key" },
      { forceRescore: true },
    );

    expect(xaiRequests).toHaveLength(2);
    expect(xaiRequests[0]).toMatchObject({
      model: "grok-4.6",
      reasoning_effort: "medium",
    });
    expect(matchUpserts).toHaveLength(2);
    expect(matchUpserts[0]).toEqual([
      {
        portfolio_id: "portfolio-1",
        condition_id: "0xrotating",
        score: 0.91,
        reason: "Rate changes affect AAPL valuation",
        is_pinned: false,
      },
    ]);
    expect(matchUpserts[1]).toEqual([
      {
        portfolio_id: "portfolio-2",
        condition_id: "0xrotating",
        score: 0,
        reason: null,
        is_pinned: false,
      },
    ]);
    expect(cacheUpsert).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      marketsUpserted: 1,
      portfoliosProcessed: 2,
      portfoliosSkipped: 0,
      curation: {
        model: "grok-4.6",
        reasoningEffort: "medium",
        forceRescore: true,
        grokRuns: 2,
        cacheHits: 0,
        fallbacks: 1,
        portfoliosWithoutHoldings: 0,
        rotatingMatchesWritten: 2,
      },
      errors: ["portfolio portfolio-2: Grok scoring returned 0 results — using volume fallback"],
    });
  });

  it("sweeps legacy pinned rows for portfolios without holdings", async () => {
    const deleteFilters: Array<[string, unknown]> = [];
    const matchUpsert = vi.fn().mockResolvedValue({ error: null });

    dbFrom.mockImplementation((table: string) => {
      if (table === "polymarket_markets") {
        return {
          upsert: vi.fn().mockResolvedValue({ error: null }),
          update: vi.fn(() => ({
            eq: vi.fn(() => ({
              or: vi.fn(() => ({
                select: vi.fn().mockResolvedValue({ data: [], error: null }),
              })),
            })),
          })),
        };
      }
      if (table === "portfolios") {
        return {
          select: vi.fn().mockResolvedValue({
            data: [{ id: "portfolio-empty", user_id: "user-1" }],
            error: null,
          }),
        };
      }
      if (table === "holdings") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              gt: vi.fn().mockResolvedValue({ data: [], error: null }),
            })),
          })),
        };
      }
      if (table === "portfolio_polymarket_matches") {
        const eq = vi.fn((column: string, value: unknown) => {
          deleteFilters.push([column, value]);
          return Object.assign(Promise.resolve({ error: null }), { eq });
        });
        return { upsert: matchUpsert, delete: vi.fn(() => ({ eq })) };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify([gammaEvent()]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    const result = await runPolymarketFanout(env);

    expect(deleteFilters).toEqual([
      ["portfolio_id", "portfolio-empty"],
      ["is_pinned", true],
    ]);
    expect(matchUpsert).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      portfoliosProcessed: 1,
      curation: { portfoliosWithoutHoldings: 1 },
      errors: [],
    });
  });
});

describe("ETF constituents in portfolio profiles", () => {
  const vwceHolding = {
    id: "holding-vwce",
    ticker: "VWCE.DE",
    isin: "IE00BK5BQT80",
    asset_type: "ETF",
    name: "Vanguard FTSE All-World",
    quantity: 10,
  };

  function profileClient({
    constituentRows = [],
    staleJobRow = false,
    insertConflict = false,
  }: {
    constituentRows?: unknown[];
    /** true = the conditional UPDATE claims an existing stale row */
    staleJobRow?: boolean;
    /** true = INSERT hits a unique violation (recent claim held elsewhere) */
    insertConflict?: boolean;
  }) {
    const jobClaims: unknown[] = [];
    const jobInserts: unknown[] = [];
    const jobDeletes: Array<Record<string, unknown>> = [];
    const client = {
      from: vi.fn((table: string) => {
        if (table === "holding_geography_allocations") {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                order: vi.fn(() => ({
                  limit: vi.fn().mockResolvedValue({ data: [], error: null }),
                })),
              })),
            })),
          };
        }
        if (table === "etf_constituents") {
          return {
            select: vi.fn(() => ({
              in: vi.fn().mockResolvedValue({ data: constituentRows, error: null }),
            })),
          };
        }
        if (table === "geography_research_jobs") {
          return {
            update: vi.fn((row: unknown) => ({
              eq: vi.fn((_col: string, holdingId: string) => ({
                or: vi.fn(() => ({
                  select: vi.fn(async () => {
                    if (staleJobRow) {
                      jobClaims.push(row);
                      return { data: [{ holding_id: holdingId }], error: null };
                    }
                    return { data: [], error: null };
                  }),
                })),
              })),
            })),
            insert: vi.fn(async (row: unknown) => {
              if (insertConflict) {
                return { error: { message: "duplicate key value", code: "23505" } };
              }
              jobInserts.push(row);
              return { error: null };
            }),
            delete: vi.fn(() => ({
              eq: vi.fn((col1: string, val1: string) => ({
                eq: vi.fn(async (col2: string, val2: string) => {
                  jobDeletes.push({ [col1]: val1, [col2]: val2 });
                  return { error: null };
                }),
              })),
            })),
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      }),
    };
    return { client, jobClaims, jobInserts, jobDeletes };
  }

  it("uses etf_constituents as the primary source, ahead of the hardcoded map", async () => {
    // PUST.PA is in the hardcoded fallback map — a DB row must still win.
    const { client } = profileClient({
      constituentRows: [
        {
          etf_isin: "LU1829221024",
          constituents: [
            { ticker: "NVDA", name: "NVIDIA" },
            { ticker: "TSM", name: "TSMC" },
          ],
          top_sectors: [{ sector: "Technology", weight_pct: 60 }],
        },
      ],
    });

    const { profile, profileSummary, constituentGaps } = await buildPortfolioProfile(
      client as never,
      "portfolio-1",
      [
        {
          id: "holding-pust",
          ticker: "PUST.PA",
          isin: "LU1829221024",
          asset_type: "ETF",
          name: "Amundi NASDAQ-100",
          quantity: 5,
        },
      ],
    );

    expect(profile.etfDescriptions).toEqual(["PUST.PA (Amundi NASDAQ-100: NVDA, TSM)"]);
    expect(profileSummary).toContain("NVDA, TSM");
    expect(profile.sectors).toEqual(["Technology"]);
    expect(constituentGaps).toEqual([]);
  });

  it("includes constituents for a non-founder ETF once enrichment has run", async () => {
    // VWCE is NOT in the hardcoded map — after the enqueued research job
    // populates etf_constituents, the profile must pick the row up.
    const { client } = profileClient({
      constituentRows: [
        {
          etf_isin: "IE00BK5BQT80",
          constituents: [
            { ticker: "AAPL", name: "Apple" },
            { ticker: "MSFT", name: "Microsoft" },
            { ticker: "NVDA", name: "NVIDIA" },
          ],
          top_sectors: [{ sector: "Technology", weight_pct: 30 }],
        },
      ],
    });

    const { profile, constituentGaps } = await buildPortfolioProfile(
      client as never,
      "portfolio-2",
      [vwceHolding],
    );

    expect(profile.etfDescriptions).toEqual([
      "VWCE.DE (Vanguard FTSE All-World: AAPL, MSFT, NVDA)",
    ]);
    expect(constituentGaps).toEqual([]);
  });

  it("degrades to ticker + name and reports a gap for a not-yet-enriched ETF", async () => {
    const { client } = profileClient({});

    const { profile, constituentGaps } = await buildPortfolioProfile(
      client as never,
      "portfolio-1",
      [vwceHolding],
    );

    expect(profile.etfDescriptions).toEqual(["VWCE.DE (Vanguard FTSE All-World)"]);
    expect(constituentGaps).toEqual([
      {
        holdingId: "holding-vwce",
        ticker: "VWCE.DE",
        isin: "IE00BK5BQT80",
        name: "Vanguard FTSE All-World",
        hasFallback: false,
      },
    ]);
  });

  it("reports a gap even when the hardcoded fallback still covers the ETF", async () => {
    const { client } = profileClient({});

    const { profile, constituentGaps } = await buildPortfolioProfile(
      client as never,
      "portfolio-1",
      [
        {
          id: "holding-pust",
          ticker: "PUST.PA",
          isin: "LU1829221024",
          asset_type: "ETF",
          name: "Amundi NASDAQ-100",
          quantity: 5,
        },
      ],
    );

    // Fallback text bridges the gap this run, but enrichment is still requested.
    expect(profile.etfDescriptions[0]).toContain("Amundi NASDAQ-100: NVDA");
    expect(constituentGaps).toHaveLength(1);
    expect(constituentGaps[0]).toMatchObject({ holdingId: "holding-pust", hasFallback: true });
  });

  it("enqueues enrichment exactly once and backs off on recent job activity", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const enrichEnv = { ...env, GEOGRAPHY_QUEUE: { send } };
    const gap = {
      holdingId: "holding-vwce",
      ticker: "VWCE.DE",
      isin: "IE00BK5BQT80",
      name: "Vanguard FTSE All-World",
      hasFallback: false,
    };

    const first = profileClient({});
    const firstResult = await enqueueEtfConstituentsEnrichment(
      enrichEnv,
      first.client as never,
      "portfolio-1",
      [gap],
    );

    expect(firstResult.enqueued).toEqual(["holding-vwce"]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      type: "geography_research",
      portfolio_id: "portfolio-1",
      holding_id: "holding-vwce",
      reason: "polymarket_constituents",
    });
    expect(first.jobInserts).toEqual([
      expect.objectContaining({
        holding_id: "holding-vwce",
        portfolio_id: "portfolio-1",
        status: "queued",
        reason: "polymarket_constituents",
      }),
    ]);

    // A later (or concurrently racing) fanout can't claim: the conditional
    // UPDATE matches nothing and the INSERT hits the unique violation.
    const second = profileClient({ insertConflict: true });
    const secondResult = await enqueueEtfConstituentsEnrichment(
      enrichEnv,
      second.client as never,
      "portfolio-1",
      [gap],
    );

    expect(secondResult.enqueued).toEqual([]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(second.jobInserts).toEqual([]);
  });

  it("re-enqueues by claiming the stale row once the backoff window has passed", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { client, jobClaims, jobInserts } = profileClient({ staleJobRow: true });

    const result = await enqueueEtfConstituentsEnrichment(
      { ...env, GEOGRAPHY_QUEUE: { send } },
      client as never,
      "portfolio-1",
      [
        {
          holdingId: "holding-vwce",
          ticker: "VWCE.DE",
          isin: "IE00BK5BQT80",
          name: "Vanguard FTSE All-World",
          hasFallback: false,
        },
      ],
    );

    expect(result.enqueued).toEqual(["holding-vwce"]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(jobClaims).toEqual([
      expect.objectContaining({ holding_id: "holding-vwce", status: "queued" }),
    ]);
    expect(jobInserts).toEqual([]);
  });

  it("releases the claim when queue delivery fails so the next fanout can retry", async () => {
    const send = vi.fn().mockRejectedValue(new Error("queue unavailable"));
    const { client, jobInserts, jobDeletes } = profileClient({});

    const result = await enqueueEtfConstituentsEnrichment(
      { ...env, GEOGRAPHY_QUEUE: { send } },
      client as never,
      "portfolio-1",
      [
        {
          holdingId: "holding-vwce",
          ticker: "VWCE.DE",
          isin: "IE00BK5BQT80",
          name: "Vanguard FTSE All-World",
          hasFallback: false,
        },
      ],
    );

    // The claim was taken, delivery failed, and the claim was released — the
    // holding is NOT reported as enqueued and no 24h suppression row remains.
    expect(jobInserts).toHaveLength(1);
    expect(result.enqueued).toEqual([]);
    expect(jobDeletes).toEqual([{ holding_id: "holding-vwce", status: "queued" }]);
  });

  it("never enqueues an ETF without an ISIN or when the queue is unbound", async () => {
    const send = vi.fn();
    const noIsin = await enqueueEtfConstituentsEnrichment(
      { ...env, GEOGRAPHY_QUEUE: { send } },
      profileClient({}).client as never,
      "portfolio-1",
      [
        {
          holdingId: "holding-x",
          ticker: "MYSTERY",
          isin: null,
          name: "Mystery Fund",
          hasFallback: false,
        },
      ],
    );
    expect(noIsin.enqueued).toEqual([]);
    expect(send).not.toHaveBeenCalled();

    const noQueue = await enqueueEtfConstituentsEnrichment(
      env,
      profileClient({}).client as never,
      "portfolio-1",
      [
        {
          holdingId: "holding-vwce",
          ticker: "VWCE.DE",
          isin: "IE00BK5BQT80",
          name: "Vanguard FTSE All-World",
          hasFallback: false,
        },
      ],
    );
    expect(noQueue.enqueued).toEqual([]);
  });
});

describe("upsertThenPrunePortfolioMatches", () => {
  const selection = {
    condition_id: "0xmarket",
    score: 0.8,
    reason: "Rate sensitivity",
  };

  it("never prunes existing rows when the replacement upsert fails", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: { message: "database unavailable" } });
    const client = { from: vi.fn(() => ({ upsert })) };

    await expect(
      upsertThenPrunePortfolioMatches(client as never, "portfolio-1", [selection]),
    ).rejects.toThrow("database unavailable");

    expect(client.from).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("upserts replacement rows before pruning stale matches", async () => {
    const calls: string[] = [];
    const upsert = vi.fn(async () => {
      calls.push("upsert");
      return { error: null };
    });
    const not = vi.fn(async () => {
      calls.push("prune");
      return { error: null };
    });
    const eq = vi.fn(() => ({ not }));
    const remove = vi.fn(() => ({ eq }));
    const client = {
      from: vi.fn().mockReturnValueOnce({ upsert }).mockReturnValueOnce({ delete: remove }),
    };

    await upsertThenPrunePortfolioMatches(client as never, "portfolio-1", [selection]);

    expect(calls).toEqual(["upsert", "prune"]);
    expect(upsert).toHaveBeenCalledWith(
      [{ portfolio_id: "portfolio-1", ...selection, is_pinned: false }],
      { onConflict: "portfolio_id,condition_id" },
    );
    expect(eq).toHaveBeenCalledTimes(1);
    expect(eq).toHaveBeenCalledWith("portfolio_id", "portfolio-1");
    expect(not).toHaveBeenCalledWith("condition_id", "in", '("0xmarket")');
  });

  it("refuses to replace a portfolio feed with an empty set", async () => {
    const client = { from: vi.fn() };

    await expect(
      upsertThenPrunePortfolioMatches(client as never, "portfolio-1", []),
    ).rejects.toThrow("refusing to replace");
    expect(client.from).not.toHaveBeenCalled();
  });
});
