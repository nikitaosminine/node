import { describe, it, expect } from "vitest";
import {
  maxFetchedAt,
  formatAge,
  isStale,
  isFallbackMatch,
  STALE_THRESHOLD_MS,
} from "@/lib/polymarket-freshness";

describe("maxFetchedAt", () => {
  it("returns null for an empty or all-invalid list", () => {
    expect(maxFetchedAt([])).toBeNull();
    expect(maxFetchedAt([null, undefined, "not-a-date"])).toBeNull();
  });

  it("returns the most recent timestamp", () => {
    const result = maxFetchedAt([
      "2026-08-16T10:00:00.000Z",
      "2026-08-16T12:00:00.000Z",
      "2026-08-16T11:00:00.000Z",
    ]);
    expect(result?.toISOString()).toBe("2026-08-16T12:00:00.000Z");
  });

  it("ignores invalid entries mixed in with valid ones", () => {
    const result = maxFetchedAt(["garbage", "2026-08-16T09:00:00.000Z", null]);
    expect(result?.toISOString()).toBe("2026-08-16T09:00:00.000Z");
  });
});

describe("formatAge", () => {
  const base = new Date("2026-08-16T12:00:00.000Z");

  it("formats sub-minute ages in seconds", () => {
    expect(formatAge(base, base.getTime() + 30_000)).toBe("30s ago");
  });

  it("formats sub-hour ages in minutes", () => {
    expect(formatAge(base, base.getTime() + 14 * 60_000)).toBe("14m ago");
  });

  it("formats hour-plus ages in hours", () => {
    expect(formatAge(base, base.getTime() + 5 * 60 * 60_000)).toBe("5h ago");
  });

  it("clamps negative drift (clock skew) to 0s", () => {
    expect(formatAge(base, base.getTime() - 5_000)).toBe("0s ago");
  });
});

describe("isStale", () => {
  const base = new Date("2026-08-16T12:00:00.000Z");

  it("is not stale with no timestamp", () => {
    expect(isStale(null, Date.parse("2026-08-16T12:00:00.000Z"))).toBe(false);
  });

  it("is not stale just under the 3h threshold", () => {
    const now = base.getTime() + STALE_THRESHOLD_MS - 1_000;
    expect(isStale(base, now)).toBe(false);
  });

  it("is stale just over the 3h threshold", () => {
    const now = base.getTime() + STALE_THRESHOLD_MS + 1_000;
    expect(isStale(base, now)).toBe(true);
  });
});

describe("isFallbackMatch", () => {
  it("flags score=0 and reason=null as fallback", () => {
    expect(isFallbackMatch({ score: 0, reason: null })).toBe(true);
  });

  it("does not flag a curated pick with a reason", () => {
    expect(isFallbackMatch({ score: 0.62, reason: "NVDA exposure" })).toBe(false);
  });

  it("does not flag a scored pick even without a reason", () => {
    expect(isFallbackMatch({ score: 0.4, reason: null })).toBe(false);
  });

  it("does not flag score=0 when a reason is present", () => {
    expect(isFallbackMatch({ score: 0, reason: "edge case" })).toBe(false);
  });
});
