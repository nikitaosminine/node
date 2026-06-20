import { describe, it, expect } from "vitest";
import { computeAllocation } from "@/lib/allocation";

describe("computeAllocation", () => {
  it("computes left and proportional segments when income covers spend", () => {
    const a = computeAllocation(3200, 1840, 760);
    expect(a.left).toBe(600);
    expect(a.isOverspent).toBe(false);
    expect(a.overBy).toBe(0);
    // denom = max(3200, 2600) = 3200
    expect(a.segments.map((s) => s.key)).toEqual(["fixed", "discretionary", "left"]);
    expect(a.segments[0].widthPct).toBeCloseTo(57.5, 1); // 1840/3200
    expect(a.segments[2].amount).toBe(600);
    // widths sum to 100% when income is fully accounted for
    expect(a.segments.reduce((sum, s) => sum + s.widthPct, 0)).toBeCloseTo(100, 0);
  });

  it("flags overspend and drops the left segment when spend exceeds income", () => {
    const a = computeAllocation(2000, 1500, 900);
    expect(a.left).toBe(-400);
    expect(a.isOverspent).toBe(true);
    expect(a.overBy).toBe(400);
    expect(a.segments.map((s) => s.key)).toEqual(["fixed", "discretionary"]);
    // denom = max(2000, 2400) = 2400; bar fills entirely with spend
    expect(a.segments.reduce((sum, s) => sum + s.widthPct, 0)).toBeCloseTo(100, 0);
  });

  it("returns null left and no left segment when income is unset", () => {
    const a = computeAllocation(null, 800, 200);
    expect(a.left).toBeNull();
    expect(a.income).toBeNull();
    expect(a.isOverspent).toBe(false);
    expect(a.segments.map((s) => s.key)).toEqual(["fixed", "discretionary"]);
    expect(a.segments[0].widthPct).toBeCloseTo(80, 0);
  });

  it("handles the all-zero case without dividing by zero", () => {
    const a = computeAllocation(0, 0, 0);
    expect(a.left).toBe(0);
    expect(a.segments.every((s) => s.widthPct === 0)).toBe(true);
  });
});
