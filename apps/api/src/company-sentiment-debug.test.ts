// Exercises GET /api/_debug/company-sentiment through the real Worker fetch
// handler: admin gating via X-Admin-Secret, and the rolling-score rows read
// back from company_sentiment over a stubbed PostgREST layer.

import { afterEach, describe, expect, it, vi } from "vitest";

import worker from "./index";

afterEach(() => {
  vi.unstubAllGlobals();
});

const env = {
  SUPABASE_URL: "http://supabase.local",
  SUPABASE_SERVICE_KEY: "service-key",
  SUPABASE_ANON_KEY: "anon-key",
  ADMIN_SECRET: "test-admin-secret",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

const sentimentRow = {
  company_key: "ticker:ACME",
  company_name: "Acme Corp",
  ticker: "ACME",
  isin: null,
  score: 0.175,
  trend: "up",
  evidence_cluster_ids: ["db-1", "db-2"],
  scored_cluster_ids: ["db-1", "db-2"],
  updated_at: "2026-08-16T12:00:00.000Z",
};

describe("GET /api/_debug/company-sentiment", () => {
  it("rejects callers without the admin secret", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      new Request("https://api.test/api/_debug/company-sentiment"),
      env,
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns rolling company scores, newest first, for admins", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/rest/v1/company_sentiment");
      expect(url.searchParams.get("order")).toBe("updated_at.desc");
      return new Response(JSON.stringify([sentimentRow]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      new Request("https://api.test/api/_debug/company-sentiment", {
        headers: { "X-Admin-Secret": "test-admin-secret" },
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ companies: [sentimentRow] });
  });
});
