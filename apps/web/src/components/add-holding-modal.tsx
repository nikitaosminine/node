"use client";

import { useEffect, useState } from "react";
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
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { normalizeCurrencyCode } from "@/lib/currency";
import { API_BASE_URL } from "@/lib/api";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  portfolioId: string;
  portfolioCurrency: string;
  onAdded: () => void;
}

interface AssetSearchResult {
  ticker: string;
  name: string;
  exchange: string;
  assetType: string;
  currency: string | null;
}

export function AddHoldingModal({
  open,
  onOpenChange,
  portfolioId,
  portfolioCurrency,
  onAdded,
}: Props) {
  const [ticker, setTicker] = useState("");
  const [name, setName] = useState("");
  const [assetType, setAssetType] = useState("");
  const [currency, setCurrency] = useState(portfolioCurrency);
  const [isin, setIsin] = useState("");
  const [date, setDate] = useState<Date | undefined>(undefined);
  const [price, setPrice] = useState("");
  const [quantity, setQty] = useState("");
  const [fees, setFees] = useState("");
  const [loading, setLoading] = useState(false);
  const [searchResults, setSearchResults] = useState<AssetSearchResult[]>([]);
  const [showSearch, setShowSearch] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);

  const reset = () => {
    setTicker("");
    setName("");
    setAssetType("");
    setCurrency(portfolioCurrency);
    setIsin("");
    setDate(undefined);
    setPrice("");
    setQty("");
    setFees("");
    setSearchResults([]);
    setShowSearch(false);
  };

  const handleOpenChange = (v: boolean) => {
    if (!v) reset();
    onOpenChange(v);
  };

  const searchStocks = (q: string) => {
    setTicker(q);
    setName("");
    setAssetType("");
    if (q.length === 0) {
      setSearchResults([]);
      setShowSearch(false);
    }
  };

  useEffect(() => {
    if (!ticker.trim()) return;

    const controller = new AbortController();
    const id = window.setTimeout(async () => {
      try {
        setSearchLoading(true);
        const res = await fetch(
          `${API_BASE_URL}/api/market/search?q=${encodeURIComponent(ticker.trim())}`,
          {
            signal: controller.signal,
          },
        );
        if (!res.ok) throw new Error("Search failed");
        const data = (await res.json()) as AssetSearchResult[];
        setSearchResults(data);
        setShowSearch(true);
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setSearchResults([]);
        }
      } finally {
        setSearchLoading(false);
      }
    }, 250);

    return () => {
      controller.abort();
      window.clearTimeout(id);
    };
  }, [ticker]);

  const selectStock = (s: AssetSearchResult) => {
    setTicker(s.ticker);
    setName(s.name);
    setAssetType(s.assetType);
    setCurrency(normalizeCurrencyCode(s.currency, portfolioCurrency));
    setIsin("");
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
      const { error } = await supabase.from("holdings").insert({
        portfolio_id: portfolioId,
        ticker: ticker.toUpperCase(),
        name: name || ticker.toUpperCase(),
        asset_type: assetType || null,
        currency: normalizeCurrencyCode(currency, portfolioCurrency),
        isin: isin || null,
        purchase_date: format(date, "yyyy-MM-dd"),
        purchase_price: parseFloat(price) || 0,
        quantity: parseFloat(quantity) || 0,
        fees: parseFloat(fees) || 0,
      });
      if (error) throw error;
      toast.success("Holding added");
      reset();
      onAdded();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to add holding");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add holding</DialogTitle>
          <DialogDescription>Add a new position to this portfolio.</DialogDescription>
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
                if (ticker) setShowSearch(true);
              }}
              onBlur={() => setTimeout(() => setShowSearch(false), 200)}
            />
            {name && <p className="text-xs text-muted-foreground mt-0.5">{name}</p>}
            {assetType && <p className="text-xs text-muted-foreground">{assetType}</p>}
            {searchLoading && <p className="text-xs text-muted-foreground mt-0.5">Searching…</p>}
            {showSearch && searchResults.length > 0 && (
              <div className="absolute z-50 mt-1 w-full rounded-md border border-border/50 bg-popover shadow-lg">
                {searchResults.map((s) => (
                  <button
                    key={s.ticker}
                    className="flex w-full items-center justify-between px-3 py-2 text-sm hover:bg-accent"
                    onMouseDown={() => selectStock(s)}
                  >
                    <div className="text-left">
                      <div className="font-medium font-mono">{s.ticker}</div>
                      <div className="text-xs text-muted-foreground">{s.name}</div>
                    </div>
                    <div className="text-right text-xs text-muted-foreground">
                      <div>{s.exchange}</div>
                      <div>{s.currency ? `${s.assetType} · ${s.currency}` : s.assetType}</div>
                    </div>
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
            <Button variant="outline" className="flex-1" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button className="flex-1" onClick={handleSubmit} disabled={loading}>
              {loading ? "Adding…" : "Add holding"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
