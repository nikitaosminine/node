"use client";

import { useEffect, useState } from "react";
import { format } from "date-fns";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TextShimmer } from "@/components/loading-ui/text-shimmer";
import { CURRENCY_OPTIONS, DEFAULT_PORTFOLIO_CURRENCY } from "@/lib/currency";

interface Category {
  id: string;
  display_name: string;
  pfc_primary: string;
  is_fixed_default: boolean;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  defaultCurrency?: string;
  onAdded: () => void;
}

// PFCv2 primaries that are inflows/transfers, not spend — hidden from the add-expense picker.
const NON_SPEND_PRIMARIES = new Set(["INCOME", "TRANSFER_IN", "TRANSFER_OUT"]);

function todayIso() {
  return format(new Date(), "yyyy-MM-dd");
}

export function AddExpenseModal({
  open,
  onOpenChange,
  userId,
  defaultCurrency = DEFAULT_PORTFOLIO_CURRENCY,
  onAdded,
}: Props) {
  const [merchant, setMerchant] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState(defaultCurrency);
  const [date, setDate] = useState(todayIso());
  const [categoryId, setCategoryId] = useState<string>("");
  const [isRecurring, setIsRecurring] = useState(false);
  const [recurringTouched, setRecurringTouched] = useState(false);
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);
  const [categoriesError, setCategoriesError] = useState(false);

  const reset = () => {
    setMerchant("");
    setAmount("");
    setCurrency(defaultCurrency);
    setDate(todayIso());
    setCategoryId("");
    setIsRecurring(false);
    setRecurringTouched(false);
    setNote("");
    setLoading(false);
  };

  // Load categories (system seed + user's own) once when the modal opens.
  useEffect(() => {
    if (!open) return;
    setCategoriesError(false);
    supabase
      .from("expense_categories")
      .select("id, display_name, pfc_primary, is_fixed_default")
      .order("display_name", { ascending: true })
      .then(({ data, error }) => {
        if (error) {
          setCategoriesError(true);
          return;
        }
        setCategories((data ?? []).filter((c) => !NON_SPEND_PRIMARIES.has(c.pfc_primary)));
      });
  }, [open]);

  const handleOpenChange = (value: boolean) => {
    if (!value) reset();
    onOpenChange(value);
  };

  const selectCategory = (id: string) => {
    setCategoryId(id);
    // Pre-set the recurring toggle from the category default until the user overrides it.
    if (!recurringTouched) {
      const cat = categories.find((c) => c.id === id);
      if (cat) setIsRecurring(cat.is_fixed_default);
    }
  };

  const handleSubmit = async () => {
    const amountValue = Number(amount);
    if (!merchant.trim()) {
      toast.error("Merchant is required");
      return;
    }
    if (!Number.isFinite(amountValue) || amountValue <= 0) {
      toast.error("Enter a valid amount");
      return;
    }
    if (!date) {
      toast.error("Date is required");
      return;
    }

    setLoading(true);
    try {
      const { error } = await supabase.from("expense_transactions").insert({
        user_id: userId,
        posted_at: date,
        merchant_name: merchant.trim(),
        amount: amountValue,
        currency,
        category_id: categoryId || null,
        is_recurring: isRecurring,
        source: "manual",
        note: note.trim() || null,
      });
      if (error) throw error;
      toast.success("Expense added");
      reset();
      onOpenChange(false);
      onAdded();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to add expense");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add expense</DialogTitle>
          <DialogDescription>Record a single expense without importing a CSV.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="expense-merchant" className="text-xs">
              Merchant *
            </Label>
            <Input
              id="expense-merchant"
              value={merchant}
              onChange={(event) => setMerchant(event.target.value)}
              placeholder="e.g. Tesco"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="expense-amount" className="text-xs">
                Amount *
              </Label>
              <Input
                id="expense-amount"
                type="number"
                min="0"
                step="0.01"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="0.00"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="expense-currency" className="text-xs">
                Currency
              </Label>
              <Select value={currency} onValueChange={setCurrency}>
                <SelectTrigger id="expense-currency">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CURRENCY_OPTIONS.map((option) => (
                    <SelectItem key={option.code} value={option.code}>
                      {option.code}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="expense-date" className="text-xs">
                Date *
              </Label>
              <Input
                id="expense-date"
                type="date"
                value={date}
                max={todayIso()}
                onChange={(event) => setDate(event.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="expense-category" className="text-xs">
                Category
              </Label>
              <Select value={categoryId} onValueChange={selectCategory}>
                <SelectTrigger id="expense-category">
                  <SelectValue placeholder="Uncategorized" />
                </SelectTrigger>
                <SelectContent>
                  {categories.map((cat) => (
                    <SelectItem key={cat.id} value={cat.id}>
                      {cat.display_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {categoriesError && (
                <p className="text-xs text-negative">
                  Couldn&apos;t load categories. You can still save as uncategorized.
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-hairline px-3 py-2.5">
            <div className="space-y-0.5">
              <Label htmlFor="expense-recurring" className="text-sm">
                Recurring / fixed cost
              </Label>
              <p className="text-xs text-muted-foreground">
                Excluded from the discretionary spending views.
              </p>
            </div>
            <Switch
              id="expense-recurring"
              checked={isRecurring}
              onCheckedChange={(value) => {
                setRecurringTouched(true);
                setIsRecurring(value);
              }}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="expense-note" className="text-xs">
              Note
            </Label>
            <Input
              id="expense-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Optional"
            />
          </div>

          <div className="flex gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              onClick={() => handleOpenChange(false)}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button type="button" className="flex-1" onClick={handleSubmit} disabled={loading}>
              {loading ? <TextShimmer>Adding</TextShimmer> : "Add expense"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
