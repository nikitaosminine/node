import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AddExpenseModal } from "@/components/expenses/add-expense-modal";

// Share mocks with the hoisted vi.mock factories below.
const { insertMock } = vi.hoisted(() => ({ insertMock: vi.fn() }));
const { toastMock } = vi.hoisted(() => ({
  toastMock: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) =>
      table === "expense_categories"
        ? { select: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }
        : { insert: insertMock },
  },
}));

vi.mock("sonner", () => ({ toast: toastMock }));

function renderModal(onAdded: () => void = () => {}) {
  return render(<AddExpenseModal open onOpenChange={() => {}} userId="u1" onAdded={onAdded} />);
}

describe("AddExpenseModal", () => {
  beforeEach(() => {
    insertMock.mockReset();
    insertMock.mockResolvedValue({ error: null });
    toastMock.success.mockReset();
    toastMock.error.mockReset();
  });

  it("blocks submit and warns when the merchant is empty", async () => {
    renderModal();
    fireEvent.change(screen.getByLabelText("Amount (EUR) *"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Add expense" }));

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("Merchant is required"));
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("blocks submit when the amount is not a positive number", async () => {
    renderModal();
    fireEvent.change(screen.getByLabelText("Merchant *"), { target: { value: "Tesco" } });
    fireEvent.change(screen.getByLabelText("Amount (EUR) *"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Add expense" }));

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("Enter a valid amount"));
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("inserts a manual, uncategorized, non-recurring expense for the current user", async () => {
    const onAdded = vi.fn();
    renderModal(onAdded);
    fireEvent.change(screen.getByLabelText("Merchant *"), { target: { value: "Tesco" } });
    fireEvent.change(screen.getByLabelText("Amount (EUR) *"), { target: { value: "12.50" } });
    fireEvent.click(screen.getByRole("button", { name: "Add expense" }));

    await waitFor(() => expect(insertMock).toHaveBeenCalledTimes(1));
    expect(insertMock.mock.calls[0][0]).toMatchObject({
      user_id: "u1",
      merchant_name: "Tesco",
      amount: 12.5,
      source: "manual",
      category_id: null,
      is_recurring: false,
    });
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect(toastMock.success).toHaveBeenCalledWith("Expense added");
  });
});
