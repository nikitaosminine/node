import { describe, it, expect } from "vitest";
import { budgetProgress } from "@/lib/budgets";

describe("budgetProgress", () => {
  it("reports under-cap progress", () => {
    const p = budgetProgress(120, 150);
    expect(p).toMatchObject({ pct: 80, ratio: 0.8, isOver: false, remaining: 30, overBy: 0 });
  });

  it("treats exactly-at-cap as not over", () => {
    const p = budgetProgress(150, 150);
    expect(p).toMatchObject({ pct: 100, ratio: 1, isOver: false, remaining: 0, overBy: 0 });
  });

  it("reports over-cap with clamped ratio and overBy", () => {
    const p = budgetProgress(180, 150);
    expect(p).toMatchObject({ pct: 120, ratio: 1, isOver: true, remaining: -30, overBy: 30 });
  });

  it("guards a zero cap without dividing by zero", () => {
    expect(budgetProgress(0, 0)).toMatchObject({ pct: 0, ratio: 0, isOver: false, overBy: 0 });
    expect(budgetProgress(10, 0)).toMatchObject({ pct: 100, ratio: 1, isOver: true, overBy: 10 });
  });

  it("clamps negative spend to zero", () => {
    expect(budgetProgress(-5, 100)).toMatchObject({ spent: 0, pct: 0, isOver: false });
  });
});
