import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { MOCK_STOCKS } from "@/lib/mock-data";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { format, parseISO } from "date-fns";
import { cn } from "@/lib/utils";
import { CurrencySelect } from "@/components/currency-select";
import { normalizeCurrencyCode } from "@/lib/currency";

interface Holding {
  id: string;
  ticker: string;
  name: string;
  isin: string | null;
  quantity: number;
  purchase_price: number;
  currency?: string | null;
  fees: number;
  purchase_date: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  holding: Holding;
  portfolioCurrency: string;
  onUpdated: () => void;
}

export function EditHoldingModal({
  open,
  onOpenChange,
  holding,
  portfolioCurrency,
  onUpdated,
}: Props) {
  const [ticker, setTicker] = useState(holding.ticker);
  const [name, setName] = useState(holding.name);
  const [isin, setIsin] = useState(holding.isin ?? "");
  const [date, setDate] = useState<Date | undefined>(() => {
    try {
      return parseISO(holding.purchase_date);
    } catch {
      return undefined;
    }
  });
  const [price, setPrice] = useState(String(holding.purchase_price));
  const [currency, setCurrency] = useState(
    normalizeCurrencyCode(holding.currency, portfolioCurrency),
  );
  const [quantity, setQty] = useState(String(holding.quantity));
  const [fees, setFees] = useState(String(holding.fees));
  const [loading, setLoading] = useState(false);
  const [searchResults, setSearchResults] = useState<typeof MOCK_STOCKS>([]);
  const [showSearch, setShowSearch] = useState(false);

  const searchStocks = (q: string) => {
    setTicker(q);
    setName("");
    if (q.length > 0) {
      setSearchResults(
        MOCK_STOCKS.filter(
          (s) =>
            s.ticker.toLowerCase().includes(q.toLowerCase()) ||
            s.name.toLowerCase().includes(q.toLowerCase()),
        ).slice(0, 5),
      );
      setShowSearch(true);
    } else {
      setSearchResults([]);
      setShowSearch(false);
    }
  };

  const selectStock = (s: (typeof MOCK_STOCKS)[0]) => {
    setTicker(s.ticker);
    setName(s.name);
    setIsin(s.isin);
    setSearchResults([]);
    setShowSearch(false);
  };

  const handleSubmit = async () => {
    if (!ticker || !date || !price || !quantity) {
      toast.error("Please fill all required fields");
      return;
    }
    setLoading(true);
    try {
      const { error } = await supabase
        .from("holdings")
        .update({
          ticker: ticker.toUpperCase(),
          name: name || ticker,
          isin: isin || null,
          currency: normalizeCurrencyCode(currency, portfolioCurrency),
          purchase_date: format(date, "yyyy-MM-dd"),
          purchase_price: parseFloat(price) || 0,
          quantity: parseFloat(quantity) || 0,
          fees: parseFloat(fees) || 0,
        })
        .eq("id", holding.id);
      if (error) throw error;
      toast.success("Holding updated");
      onUpdated();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to update holding");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit holding</DialogTitle>
          <DialogDescription>Update the details for this position.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Stock search */}
          <div className="relative">
            <Label className="text-xs">Stock *</Label>
            <Input
              placeholder="Search by ticker or name…"
              value={ticker}
              onChange={(e) => searchStocks(e.target.value)}
              onFocus={() => {
                if (ticker) searchStocks(ticker);
              }}
              onBlur={() => setTimeout(() => setShowSearch(false), 200)}
            />
            {name && <p className="text-xs text-muted-foreground mt-0.5">{name}</p>}
            {showSearch && searchResults.length > 0 && (
              <div className="absolute z-50 mt-1 w-full rounded-md border border-border/50 bg-popover shadow-lg">
                {searchResults.map((s) => (
                  <button
                    key={s.ticker}
                    className="flex w-full items-center justify-between px-3 py-2 text-sm hover:bg-accent"
                    onMouseDown={() => selectStock(s)}
                  >
                    <span className="font-medium font-mono">{s.ticker}</span>
                    <span className="text-xs text-muted-foreground">{s.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {/* Date */}
            <div>
              <Label className="text-xs">Purchase date *</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn(
                      "w-full justify-start text-left text-sm font-normal",
                      !date && "text-muted-foreground",
                    )}
                  >
                    {date ? format(date, "MMM dd, yyyy") : "Pick a date"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={date}
                    onSelect={setDate}
                    disabled={(d) => d > new Date()}
                    className="p-3 pointer-events-auto"
                  />
                </PopoverContent>
              </Popover>
            </div>

            {/* Price */}
            <div>
              <Label className="text-xs">Purchase price *</Label>
              <Input
                type="number"
                step="0.01"
                placeholder="0.00"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
              />
            </div>

            <div>
              <Label className="text-xs">Currency</Label>
              <CurrencySelect value={currency} onValueChange={setCurrency} />
            </div>

            {/* Quantity */}
            <div>
              <Label className="text-xs">Quantity *</Label>
              <Input
                type="number"
                step="0.01"
                placeholder="0"
                value={quantity}
                onChange={(e) => setQty(e.target.value)}
              />
            </div>

            {/* Fees */}
            <div>
              <Label className="text-xs">Fees</Label>
              <Input
                type="number"
                step="0.01"
                placeholder="0.00"
                value={fees}
                onChange={(e) => setFees(e.target.value)}
              />
            </div>
          </div>

          <div className="flex gap-2 pt-1">
            <Button variant="outline" className="flex-1" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button className="flex-1" onClick={handleSubmit} disabled={loading}>
              {loading ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
