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
import { TextShimmer } from "@/components/loading-ui/text-shimmer";
import { DEFAULT_PORTFOLIO_CURRENCY } from "@/lib/currency";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  /** Pre-fill month (YYYY-MM); defaults to the current month. */
  defaultMonth?: string;
  onSaved?: () => void;
}

// Manual monthly income — the override path for the allocation strip's "Left" figure,
// and the "Set income" action in the first-run onboarding. Writes expense_income.
export function SetIncomeDialog({ open, onOpenChange, userId, defaultMonth, onSaved }: Props) {
  const baseCurrency = DEFAULT_PORTFOLIO_CURRENCY;
  const [month, setMonth] = useState(defaultMonth ?? format(new Date(), "yyyy-MM"));
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);

  const reset = () => {
    setMonth(defaultMonth ?? format(new Date(), "yyyy-MM"));
    setAmount("");
    setLoading(false);
  };

  // Re-sync the month field to the caller's month each time the dialog opens. The parent's
  // viewed month can change (page-wide month nav) while this dialog sits mounted-but-closed,
  // and useState only seeds `month` once — without this, income would save to a stale month.
  useEffect(() => {
    if (open) setMonth(defaultMonth ?? format(new Date(), "yyyy-MM"));
  }, [open, defaultMonth]);

  const handleSubmit = async () => {
    const amountValue = Number(amount);
    if (!/^\d{4}-\d{2}$/.test(month)) {
      toast.error("Pick a month");
      return;
    }
    if (!Number.isFinite(amountValue) || amountValue <= 0) {
      toast.error("Enter a valid amount");
      return;
    }
    setLoading(true);
    try {
      const { error } = await supabase
        .from("expense_income")
        .upsert(
          { user_id: userId, month: `${month}-01`, amount: amountValue, currency: baseCurrency },
          { onConflict: "user_id,month" },
        );
      if (error) throw error;
      toast.success("Monthly income saved");
      reset();
      onOpenChange(false);
      onSaved?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save income");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) reset();
        onOpenChange(value);
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Set monthly income</DialogTitle>
          <DialogDescription>
            Used to work out what&apos;s left after fixed and discretionary spending.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Viewport breakpoint: the dialog portals to <body>, outside the page @container. */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="income-month" className="text-xs">
                Month
              </Label>
              <Input
                id="income-month"
                type="month"
                value={month}
                max={format(new Date(), "yyyy-MM")}
                onChange={(event) => setMonth(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="income-amount" className="text-xs">
                Income ({baseCurrency})
              </Label>
              <Input
                id="income-amount"
                type="number"
                min="0"
                step="0.01"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="0.00"
              />
            </div>
          </div>

          <div className="flex gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              onClick={() => onOpenChange(false)}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button type="button" className="flex-1" onClick={handleSubmit} disabled={loading}>
              {loading ? <TextShimmer>Saving</TextShimmer> : "Save income"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
