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

// Chainable query-builder stub: every method returns the same chain, and the chain is
// awaitable. Tolerates any query shape (.order().limit(), .gte().lte(), .eq().maybeSingle())
// so the list AND the allocation strip can both read from one mock.
function chain(result: { data: unknown; error: unknown }) {
  const c: Record<string, unknown> = {};
  for (const m of ["select", "order", "limit", "gte", "lte", "eq", "in"]) c[m] = () => c;
  c.maybeSingle = () => Promise.resolve(result);
  c.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return c;
}

function mockLoad(txns: Row[] | null, txnError: { message: string } | null = null) {
  fromMock.mockImplementation((table: string) => {
    if (table === "expense_transactions") return chain({ data: txns, error: txnError });
    if (table === "expense_income") return chain({ data: null, error: null });
    return chain({ data: [], error: null }); // expense_categories
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

  it("shows the import-led onboarding when there are no expenses", async () => {
    mockLoad([]);
    render(<Expenses />);
    expect(await screen.findByText("Start tracking your spending")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /import transactions/i })).toBeInTheDocument();
  });

  it("shows a distinct error state with retry when the load fails", async () => {
    mockLoad(null, { message: "boom" });
    render(<Expenses />);
    expect(await screen.findByText(/Couldn't load your expenses/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});
