import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { dbFrom } = vi.hoisted(() => ({ dbFrom: vi.fn() }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ from: dbFrom })),
}));

import {
  NON_FINANCIAL_RE,
  TAG_IDS,
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
              eq: vi.fn(() => ({
                not: vi.fn().mockResolvedValue({ error: null }),
              })),
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
});

describe("upsertThenPrunePortfolioMatches", () => {
  const selection = {
    condition_id: "0xmarket",
    score: 0.8,
    reason: "Rate sensitivity",
    is_pinned: false,
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
    const secondEq = vi.fn(() => ({ not }));
    const firstEq = vi.fn(() => ({ eq: secondEq }));
    const remove = vi.fn(() => ({ eq: firstEq }));
    const client = {
      from: vi.fn().mockReturnValueOnce({ upsert }).mockReturnValueOnce({ delete: remove }),
    };

    await upsertThenPrunePortfolioMatches(client as never, "portfolio-1", [selection]);

    expect(calls).toEqual(["upsert", "prune"]);
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
