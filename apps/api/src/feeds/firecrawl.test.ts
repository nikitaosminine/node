import { afterEach, describe, expect, it, vi } from "vitest";

import {
  firecrawlSearchNews,
  isGoogleWrappedUrl,
  mapFirecrawlNewsResults,
  normalizeFirecrawlKey,
  parseFirecrawlDate,
  providerScore,
  resolvePublishedAt,
} from "./firecrawl";

const NOW = Date.parse("2026-08-16T12:00:00.000Z");

describe("normalizeFirecrawlKey", () => {
  it("prefixes a bare hex token with fc-", () => {
    expect(normalizeFirecrawlKey("0123456789abcdef0123456789abcdef")).toBe(
      "fc-0123456789abcdef0123456789abcdef",
    );
  });

  it("keeps an already-prefixed key unchanged", () => {
    expect(normalizeFirecrawlKey("fc-abc123")).toBe("fc-abc123");
  });

  it("trims whitespace before checking the prefix", () => {
    expect(normalizeFirecrawlKey("  fc-abc123\n")).toBe("fc-abc123");
  });
});

describe("providerScore", () => {
  it("decays 0.95^(position-1) from rank 1", () => {
    expect(providerScore(1)).toBe(1);
    expect(providerScore(5)).toBeCloseTo(0.95 ** 4, 10);
    expect(providerScore(10)).toBeCloseTo(0.95 ** 9, 10);
    expect(providerScore(25)).toBeCloseTo(0.95 ** 24, 10);
  });

  it("clamps deep ranks to 0.2", () => {
    expect(providerScore(60)).toBe(0.2);
  });

  it("defaults missing or invalid positions to 0.5", () => {
    expect(providerScore(undefined)).toBe(0.5);
    expect(providerScore(null)).toBe(0.5);
    expect(providerScore(0)).toBe(0.5);
    expect(providerScore(Number.NaN)).toBe(0.5);
  });
});

describe("parseFirecrawlDate", () => {
  it("parses relative minute/hour/day/week/month strings", () => {
    expect(parseFirecrawlDate("32 minutes ago", NOW)).toBe(
      new Date(NOW - 32 * 60_000).toISOString(),
    );
    expect(parseFirecrawlDate("1 hour ago", NOW)).toBe(new Date(NOW - 3_600_000).toISOString());
    expect(parseFirecrawlDate("5 days ago", NOW)).toBe(
      new Date(NOW - 5 * 86_400_000).toISOString(),
    );
    expect(parseFirecrawlDate("2 weeks ago", NOW)).toBe(
      new Date(NOW - 14 * 86_400_000).toISOString(),
    );
    expect(parseFirecrawlDate("1 month ago", NOW)).toBe(
      new Date(NOW - 30 * 86_400_000).toISOString(),
    );
  });

  it("falls back to Date.parse for absolute dates", () => {
    expect(parseFirecrawlDate("Nov 12, 2017", NOW)).toBe(
      new Date(Date.parse("Nov 12, 2017")).toISOString(),
    );
  });

  it("returns null for missing or unparseable input", () => {
    expect(parseFirecrawlDate(undefined, NOW)).toBeNull();
    expect(parseFirecrawlDate("", NOW)).toBeNull();
    expect(parseFirecrawlDate("sometime soon", NOW)).toBeNull();
  });
});

describe("resolvePublishedAt", () => {
  it("prefers metadata ISO timestamps over the relative date", () => {
    const iso = "2026-08-14T09:30:00.000Z";
    expect(
      resolvePublishedAt({ date: "5 days ago", metadata: { "article:published_time": iso } }, NOW),
    ).toBe(iso);
  });

  it("checks the site-variant metadata keys in order", () => {
    const iso = "2026-08-13T10:00:00.000Z";
    expect(resolvePublishedAt({ metadata: { publishedTime: iso } }, NOW)).toBe(iso);
    expect(resolvePublishedAt({ metadata: { datePublished: iso } }, NOW)).toBe(iso);
    expect(resolvePublishedAt({ metadata: { "article.published": iso } }, NOW)).toBe(iso);
  });

  it("takes the first entry of an array-valued metadata key", () => {
    const iso = "2026-08-12T08:00:00.000Z";
    expect(resolvePublishedAt({ metadata: { "article:published_time": [iso, "junk"] } }, NOW)).toBe(
      iso,
    );
  });

  it("ignores unparseable metadata values and falls back to the relative date", () => {
    expect(
      resolvePublishedAt(
        { date: "2 days ago", metadata: { "article:published_time": "not a date" } },
        NOW,
      ),
    ).toBe(new Date(NOW - 2 * 86_400_000).toISOString());
  });
});

describe("isGoogleWrappedUrl", () => {
  it("matches google.com hosts including subdomains", () => {
    expect(isGoogleWrappedUrl("https://www.google.com/goto?url=AbC")).toBe(true);
    expect(isGoogleWrappedUrl("https://news.google.com/articles/x")).toBe(true);
  });

  it("does not match ordinary news hosts or invalid URLs", () => {
    expect(isGoogleWrappedUrl("https://www.reuters.com/markets/apple")).toBe(false);
    expect(isGoogleWrappedUrl("not a url")).toBe(false);
  });
});

describe("mapFirecrawlNewsResults", () => {
  it("maps news items to the provider-agnostic shape", () => {
    const { results, googleWrappedDropped } = mapFirecrawlNewsResults(
      [
        {
          url: "https://www.reuters.com/apple-exclusive",
          title: "Exclusive: Apple to expand",
          date: "2 days ago",
          position: 1,
          summary: "Apple plans to expand production.",
          metadata: { "og:image": "https://static.reuters.com/apple.jpg" },
        },
      ],
      NOW,
    );

    expect(googleWrappedDropped).toBe(0);
    expect(results).toEqual([
      {
        url: "https://www.reuters.com/apple-exclusive",
        title: "Exclusive: Apple to expand",
        publishedAt: new Date(NOW - 2 * 86_400_000).toISOString(),
        summary: "Apple plans to expand production.",
        image: "https://static.reuters.com/apple.jpg",
        providerScore: 1,
      },
    ]);
  });

  it("drops google.com/goto redirect wrappers and counts them", () => {
    const { results, googleWrappedDropped } = mapFirecrawlNewsResults(
      [
        { url: "https://www.google.com/goto?url=AbC", title: "Wrapped", date: "1 day ago" },
        { url: "https://www.ft.com/real-story", title: "Real", date: "1 day ago", position: 2 },
      ],
      NOW,
    );

    expect(googleWrappedDropped).toBe(1);
    expect(results.map((r) => r.url)).toEqual(["https://www.ft.com/real-story"]);
  });

  it("never uses the base64 imageUrl thumbnail; missing og:image → null", () => {
    const { results } = mapFirecrawlNewsResults(
      [
        {
          url: "https://www.cnbc.com/story",
          title: "Story",
          date: "1 day ago",
          position: 1,
          imageUrl: "data:image/jpeg;base64,AAAA",
        },
      ],
      NOW,
    );

    expect(results[0].image).toBeNull();
  });

  it("rejects non-http og:image values", () => {
    const { results } = mapFirecrawlNewsResults(
      [
        {
          url: "https://www.cnbc.com/story",
          title: "Story",
          date: "1 day ago",
          metadata: { "og:image": "data:image/png;base64,BBBB" },
        },
      ],
      NOW,
    );

    expect(results[0].image).toBeNull();
  });

  it("keeps results with failed scrapes: empty summary, null publishedAt when undated", () => {
    const { results } = mapFirecrawlNewsResults(
      [{ url: "https://www.wsj.com/paywalled", title: "Paywalled", position: 3 }],
      NOW,
    );

    expect(results[0].summary).toBe("");
    expect(results[0].publishedAt).toBeNull();
    expect(results[0].providerScore).toBeCloseTo(0.95 ** 2, 10);
  });

  it("skips items without a URL", () => {
    const { results } = mapFirecrawlNewsResults([{ title: "No URL" }], NOW);
    expect(results).toEqual([]);
  });
});

describe("firecrawlSearchNews", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("builds the v2 search request with news source, tbs window, and inline summaries", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        captured = { url, init };
        return new Response(JSON.stringify({ success: true, data: { news: [] } }), {
          status: 200,
        });
      }),
    );

    const response = await firecrawlSearchNews("0123abcd", {
      query: "Airbus SE latest news and developments",
      limit: 10,
      location: "FR",
      includeDomains: ["ft.com", "reuters.com"],
    });

    expect(response.success).toBe(true);
    expect(captured!.url).toBe("https://api.firecrawl.dev/v2/search");
    const headers = captured!.init.headers as Record<string, string>;
    // Bare secrets are normalized to the fc- form the API requires.
    expect(headers.Authorization).toBe("Bearer fc-0123abcd");
    expect(JSON.parse(String(captured!.init.body))).toEqual({
      query: "Airbus SE latest news and developments",
      sources: ["news"],
      limit: 10,
      tbs: "qdr:w",
      location: "FR",
      includeDomains: ["ft.com", "reuters.com"],
      scrapeOptions: { formats: ["summary"] },
    });
  });

  it("retries 429/5xx with backoff and succeeds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("oops", { status: 500 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, data: { news: [] } }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const promise = firecrawlSearchNews("fc-key", {
      query: "q",
      limit: 10,
      location: "FR",
      includeDomains: [],
    });
    await vi.runAllTimersAsync();
    const response = await promise;

    expect(response.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("fails fast on deterministic 4xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      firecrawlSearchNews("fc-key", { query: "q", limit: 10, location: "FR", includeDomains: [] }),
    ).rejects.toThrow("Firecrawl 400");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after 3 transient failures", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(new Response("down", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = firecrawlSearchNews("fc-key", {
      query: "q",
      limit: 10,
      location: "FR",
      includeDomains: [],
    }).catch((err: Error) => err);
    await vi.runAllTimersAsync();
    const err = await promise;

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("Firecrawl 503 after 3 attempts");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
