import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import Expenses from "@/routes/expenses";

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }));

vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: fromMock } }));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1" },
    isLoading: false,
    isAuthenticated: true,
    session: {},
    signIn: vi.fn(),
    signUp: vi.fn(),
    signInWithGoogle: vi.fn(),
    signOut: vi.fn(),
  }),
}));

type Row = {
  id: string;
  posted_at: string;
  merchant_name: string;
  amount: number;
  currency: string;
  is_recurring: boolean;
  category_id: string | null;
};

function mockLoad(txns: Row[] | null, txnError: { message: string } | null = null) {
  fromMock.mockImplementation((table: string) => {
    if (table === "expense_transactions") {
      return {
        select: () => ({
          order: () => ({
            limit: () => Promise.resolve({ data: txns, error: txnError }),
          }),
        }),
      };
    }
    // expense_categories
    return { select: () => Promise.resolve({ data: [], error: null }) };
  });
}

describe("Expenses route", () => {
  beforeEach(() => {
    fromMock.mockReset();
  });

  it("renders the user's expenses", async () => {
    mockLoad([
      {
        id: "t1",
        posted_at: "2026-06-10",
        merchant_name: "Tesco",
        amount: 12.5,
        currency: "EUR",
        is_recurring: false,
        category_id: null,
      },
    ]);
    render(<Expenses />);
    expect(await screen.findByText("Tesco")).toBeInTheDocument();
  });

  it("shows the empty state when there are no expenses", async () => {
    mockLoad([]);
    render(<Expenses />);
    expect(await screen.findByText("No expenses yet.")).toBeInTheDocument();
  });

  it("shows a distinct error state with retry when the load fails", async () => {
    mockLoad(null, { message: "boom" });
    render(<Expenses />);
    expect(await screen.findByText(/Couldn't load your expenses/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});
