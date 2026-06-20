"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { budgetProgress } from "@/lib/budgets";
import { formatCurrency } from "@/lib/currency";

interface Props {
  userId: string;
  categoryId: string;
  categoryName: string;
  spent: number;
  cap: number | null;
  currency: string;
  onChange: () => void;
}

// Opt-in per-category cap (Linear 1A-111). With no cap set the trigger is a quiet, hover-
// revealed "Set cap" — the calm default carries no cap chrome. Once set, it shows progress
// vs cap with an over/under badge (over = --negative). Writes expense_budgets.
export function CategoryCapControl({
  userId,
  categoryId,
  categoryName,
  spent,
  cap,
  currency,
  onChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(cap != null ? String(cap) : "");
  const [saving, setSaving] = useState(false);

  // Keep the input in sync when the persisted cap changes (e.g. after a refetch).
  useEffect(() => {
    if (!open) setValue(cap != null ? String(cap) : "");
  }, [cap, open]);

  const save = async () => {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("Enter a valid cap amount");
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase
        .from("expense_budgets")
        .upsert(
          { user_id: userId, category_id: categoryId, period: "monthly", amount },
          { onConflict: "user_id,category_id,period" },
        );
      if (error) throw error;
      toast.success(`Cap set for ${categoryName}`);
      setOpen(false);
      onChange();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save cap");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    try {
      const { error } = await supabase
        .from("expense_budgets")
        .delete()
        .eq("category_id", categoryId)
        .eq("period", "monthly");
      if (error) throw error;
      toast.success(`Cap removed for ${categoryName}`);
      setOpen(false);
      onChange();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to remove cap");
    } finally {
      setSaving(false);
    }
  };

  const progress = cap != null ? budgetProgress(spent, cap) : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {progress ? (
          <button
            type="button"
            aria-label={`Cap for ${categoryName}: ${formatCurrency(spent, currency)} of ${formatCurrency(progress.cap, currency)}${progress.isOver ? `, over by ${formatCurrency(progress.overBy, currency)}` : ""}. Edit cap.`}
            className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] tabular-nums transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {progress.isOver ? (
              <span className="text-negative">
                Over {formatCurrency(progress.overBy, currency, { maximumFractionDigits: 0 })}
              </span>
            ) : (
              <span className="text-foreground-muted">
                {formatCurrency(progress.remaining, currency, { maximumFractionDigits: 0 })} left
              </span>
            )}
          </button>
        ) : (
          <button
            type="button"
            aria-label={`Set a monthly cap for ${categoryName}`}
            className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-foreground-muted opacity-0 transition-opacity hover:bg-surface-2 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/row:opacity-100"
          >
            Set cap
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent className="w-60 p-3" align="end">
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor={`cap-${categoryId}`} className="text-xs">
              Monthly cap · {categoryName} ({currency})
            </Label>
            <Input
              id={`cap-${categoryId}`}
              type="number"
              min="0"
              step="0.01"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="0.00"
              autoFocus
            />
          </div>
          {progress && (
            <p className="text-[11px] text-foreground-muted">
              Spent {formatCurrency(progress.spent, currency, { maximumFractionDigits: 0 })} of{" "}
              {formatCurrency(progress.cap, currency, { maximumFractionDigits: 0 })} ({progress.pct}
              %)
            </p>
          )}
          <div className="flex gap-2">
            {cap != null && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={remove}
                disabled={saving}
              >
                Remove
              </Button>
            )}
            <Button type="button" size="sm" className="flex-1" onClick={save} disabled={saving}>
              {cap != null ? "Update" : "Set cap"}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
