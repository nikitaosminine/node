"use client";

import { format, parseISO } from "date-fns";
import { Mic, Sparkles } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/currency";
import type { HeatmapTxn } from "@/lib/heatmap";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  date: string | null;
  txns: HeatmapTxn[];
  categoryNames: Record<string, string>;
  currency: string;
}

// Click a heatmap cell → this drawer lists that day's transactions. The "Ask Node" and
// voice actions are stubs (agent not wired yet, 1A-103), present so the affordance ships.
export function HeatmapCellPanel({
  open,
  onOpenChange,
  date,
  txns,
  categoryNames,
  currency,
}: Props) {
  const total = txns.reduce((sum, t) => sum + t.amount, 0);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-sm">
        <SheetHeader>
          <SheetTitle>{date ? format(parseISO(date), "EEEE, d MMM") : "Day"}</SheetTitle>
          <SheetDescription>
            <span className="font-mono tabular-nums text-foreground">
              {formatCurrency(total, currency)}
            </span>{" "}
            · {txns.length} transaction{txns.length === 1 ? "" : "s"}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4 py-2">
          {txns.length === 0 ? (
            <p className="px-1 py-8 text-center text-sm text-foreground-muted">
              No transactions on this day.
            </p>
          ) : (
            <ul className="divide-y divide-hairline">
              {txns.map((t) => (
                <li key={t.id} className="flex items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{t.merchant_name}</div>
                    {t.category_id && categoryNames[t.category_id] && (
                      <div className="text-xs text-foreground-muted">
                        {categoryNames[t.category_id]}
                      </div>
                    )}
                  </div>
                  <div className="font-mono text-sm tabular-nums">
                    {formatCurrency(t.amount, currency)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* AI stubs — affordance present, agent not wired yet. */}
        <div className="border-t border-hairline p-4">
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="flex-1" disabled title="Coming soon">
              <Sparkles className="h-4 w-4" />
              Ask Node
            </Button>
            <Button variant="outline" size="icon" disabled title="Voice — coming soon">
              <Mic className="h-4 w-4" />
            </Button>
          </div>
          <p className="mt-1.5 text-center text-[11px] text-foreground-muted">
            Node explanations coming soon
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
}
