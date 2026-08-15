import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { dbFrom } = vi.hoisted(() => ({ dbFrom: vi.fn() }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ from: dbFrom })),
}));

import {
  TAG_IDS,
  fetchCandidateMarkets,
  runPolymarketFanout,
  upsertThenPrunePortfolioMatches,
} from "./polymarket";

const env = {
  SUPABASE_URL: "https://supabase.example",
  SUPABASE_SERVICE_KEY: "service-key",
  POLYMARKET_GAMMA_BASE_URL: "https://gamma.example",
};

function gammaEvent(conditionId = "0xmarket") {
  return {
    id: "event-1",
    slug: "fed-rates-2026",
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
