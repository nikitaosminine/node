// Regression: ISSUE-001 — "Set income" pre-filled a stale month after page-wide month
// navigation. The dialog mounts closed inside the Node section; useState seeded `month`
// only once, so opening it after navigating saved income to the wrong month.
// Found by /qa on 2026-06-21
// Report: .gstack/qa-reports/qa-report-expenses-2026-06-21.md
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SetIncomeDialog } from "@/components/expenses/set-income-dialog";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: () => ({ upsert: vi.fn().mockResolvedValue({ error: null }) }) },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

describe("SetIncomeDialog month sync", () => {
  it("shows the caller's current month when opened, even if it changed while closed", () => {
    // Mounts closed with June as the viewed month — mirrors the dialog sitting in the
    // Node section before the user navigates.
    const { rerender } = render(
      <SetIncomeDialog open={false} onOpenChange={() => {}} userId="u1" defaultMonth="2026-06" />,
    );

    // User pages back to April (defaultMonth changes) and only then opens the dialog.
    rerender(<SetIncomeDialog open onOpenChange={() => {}} userId="u1" defaultMonth="2026-04" />);

    // Must reflect April — the month being viewed — not the stale mount-time June.
    expect((screen.getByLabelText("Month") as HTMLInputElement).value).toBe("2026-04");
  });
});
