"use client";

import { useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { Search } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TextShimmer } from "@/components/loading-ui/text-shimmer";
import { API_BASE_URL } from "@/lib/api";

export type Side = "BUY" | "SELL" | "DEP" | "WD" | "DIV" | "FEE";

interface AssetSearchResult {
  ticker: string;
  name: string;
  exchange: string;
  assetType: string;
  currency: string | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  portfolioId: string;
  transaction?: EditableTransaction | null;
  onAdded: () => void;
}

export interface EditableTransaction {
  id: string;
  date: string;
  symbol: string;
  isin: string | null;
  yahoo_ticker: string | null;
  side: Side;
  quantity: number | null;
  net_amount: number | null;
  commission: number;
}

const SIDES: Array<{ value: Side; label: string }> = [
  { value: "BUY", label: "Buy" },
  { value: "SELL", label: "Sell" },
  { value: "DEP", label: "Deposit" },
  { value: "WD", label: "Withdrawal" },
  { value: "DIV", label: "Dividend" },
  { value: "FEE", label: "Fee" },
];

const NEGATIVE_SIDES = new Set<Side>(["BUY", "WD", "FEE"]);
const ASSET_BACKED_SIDES = new Set<Side>(["BUY", "SELL", "DIV"]);

function todayIso() {
  return format(new Date(), "yyyy-MM-dd");
}

function tickerFromTypedValue(value: string): string | null {
  const trimmed = value.trim().toUpperCase();
  return /^[A-Z0-9.-]{1,15}$/.test(trimmed) ? trimmed : null;
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Not authenticated");
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

export function ManualTransactionModal({
  open,
  onOpenChange,
  portfolioId,
  transaction,
  onAdded,
}: Props) {
  const [date, setDate] = useState(todayIso());
  const [side, setSide] = useState<Side>("DIV");
  const [assetQuery, setAssetQuery] = useState("");
  const [selectedAsset, setSelectedAsset] = useState<AssetSearchResult | null>(null);
  const [isin, setIsin] = useState("");
  const [quantity, setQuantity] = useState("");
  const [amount, setAmount] = useState("");
  const [commission, setCommission] = useState("");
  const [loading, setLoading] = useState(false);
  const [searchResults, setSearchResults] = useState<AssetSearchResult[]>([]);
  const [showSearch, setShowSearch] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);

  const isEditing = Boolean(transaction);
  const isAssetBacked = ASSET_BACKED_SIDES.has(side);
  const requiresQuantity = side === "BUY" || side === "SELL";
  const showsQuantity = requiresQuantity || side === "DIV";
  const signedAmountHint = NEGATIVE_SIDES.has(side) ? "Stored as negative" : "Stored as positive";
  const amountValue = Number(amount);
  const quantityValue = Number(quantity);
  const dividendPerShare =
    side === "DIV" &&
    Number.isFinite(amountValue) &&
    amountValue > 0 &&
    Number.isFinite(quantityValue) &&
    quantityValue > 0
      ? amountValue / quantityValue
      : null;

  const selectedTicker = useMemo(() => {
    if (!isAssetBacked) return null;
    return selectedAsset?.ticker ?? tickerFromTypedValue(assetQuery);
  }, [assetQuery, isAssetBacked, selectedAsset]);

  const reset = () => {
    setDate(todayIso());
    setSide("DIV");
    setAssetQuery("");
    setSelectedAsset(null);
    setIsin("");
    setQuantity("");
    setAmount("");
    setCommission("");
    setLoading(false);
    setSearchResults([]);
    setShowSearch(false);
    setSearchLoading(false);
  };

  useEffect(() => {
    if (!open || !transaction) return;
    setDate(transaction.date);
    setSide(transaction.side);
    setAssetQuery(transaction.yahoo_ticker ?? transaction.symbol);
    setSelectedAsset(null);
    setIsin(transaction.isin ?? "");
    setQuantity(transaction.quantity == null ? "" : String(transaction.quantity));
    setAmount(transaction.net_amount == null ? "" : String(Math.abs(transaction.net_amount)));
    setCommission(transaction.commission ? String(transaction.commission) : "");
    setLoading(false);
    setSearchResults([]);
    setShowSearch(false);
    setSearchLoading(false);
  }, [open, transaction]);

  const handleOpenChange = (value: boolean) => {
    if (!value) reset();
    onOpenChange(value);
  };

  const updateAssetQuery = (value: string) => {
    setAssetQuery(value);
    setSelectedAsset(null);
    if (!value.trim()) {
      setSearchResults([]);
      setShowSearch(false);
    }
  };

  useEffect(() => {
    if (!open || !isAssetBacked || !assetQuery.trim() || selectedAsset) return;

    const controller = new AbortController();
    const timeoutId = window.setTimeout(async () => {
      try {
        setSearchLoading(true);
        const res = await fetch(
          `${API_BASE_URL}/api/market/search?q=${encodeURIComponent(assetQuery.trim())}`,
          { signal: controller.signal },
        );
        if (!res.ok) throw new Error("Search failed");
        const data = (await res.json()) as AssetSearchResult[];
        setSearchResults(data);
        setShowSearch(data.length > 0);
      } catch (error) {
        if ((error as Error).name !== "AbortError") setSearchResults([]);
      } finally {
        setSearchLoading(false);
      }
    }, 250);

    return () => {
      controller.abort();
      window.clearTimeout(timeoutId);
    };
  }, [assetQuery, isAssetBacked, open, selectedAsset]);

  const selectAsset = (asset: AssetSearchResult) => {
    setSelectedAsset(asset);
    setAssetQuery(asset.ticker);
    setSearchResults([]);
    setShowSearch(false);
  };

  const handleSubmit = async () => {
    const commissionValue = Number(commission || "0");
    const unchangedEditAsset =
      transaction && assetQuery.trim() === (transaction.yahoo_ticker ?? transaction.symbol);
    const assetSymbol =
      selectedAsset?.name || (unchangedEditAsset ? transaction.symbol : assetQuery.trim());

    if (!date) {
      toast.error("Date is required");
      return;
    }
    if (!Number.isFinite(amountValue) || amountValue <= 0) {
      toast.error("Enter a valid amount");
      return;
    }
    if (requiresQuantity && (!Number.isFinite(quantityValue) || quantityValue <= 0)) {
      toast.error("Quantity is required for buys and sells");
      return;
    }
    if (side === "DIV" && quantity && (!Number.isFinite(quantityValue) || quantityValue <= 0)) {
      toast.error("Enter a valid dividend quantity");
      return;
    }
    if (isAssetBacked && !assetSymbol) {
      toast.error("Asset is required for this transaction");
      return;
    }
    if (commission && (!Number.isFinite(commissionValue) || commissionValue < 0)) {
      toast.error("Enter a valid commission");
      return;
    }

    setLoading(true);
    try {
      const signedNetAmount = NEGATIVE_SIDES.has(side) ? -amountValue : amountValue;
      const res = await fetch(
        isEditing
          ? `${API_BASE_URL}/api/portfolios/${portfolioId}/transactions/${transaction!.id}`
          : `${API_BASE_URL}/api/portfolios/${portfolioId}/transactions`,
        {
          method: isEditing ? "PATCH" : "POST",
          headers: await authHeaders(),
          body: JSON.stringify(
            isEditing
              ? {
                  row: {
                    date,
                    symbol: isAssetBacked ? assetSymbol : "CASH",
                    isin: isAssetBacked && isin.trim() ? isin.trim().toUpperCase() : null,
                    yahoo_ticker: selectedTicker,
                    side,
                    quantity: showsQuantity && quantity ? quantityValue : null,
                    net_amount: signedNetAmount,
                    commission: commissionValue,
                  },
                }
              : {
                  rows: [
                    {
                      date,
                      symbol: isAssetBacked ? assetSymbol : "CASH",
                      isin: isAssetBacked && isin.trim() ? isin.trim().toUpperCase() : null,
                      yahoo_ticker: selectedTicker,
                      side,
                      quantity: showsQuantity && quantity ? quantityValue : null,
                      net_amount: signedNetAmount,
                      commission: commissionValue,
                    },
                  ],
                },
          ),
        },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save transaction");
      toast.success(
        isEditing
          ? "Transaction updated. Chart rebuild queued."
          : "Transaction added. Chart rebuild queued.",
      );
      reset();
      onOpenChange(false);
      onAdded();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to add transaction");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit transaction" : "Add transaction"}</DialogTitle>
          <DialogDescription>
            {isEditing
              ? "Update this transaction and rebuild portfolio history."
              : "Add one transaction without importing a CSV."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="manual-transaction-date" className="text-xs">
                Date *
              </Label>
              <Input
                id="manual-transaction-date"
                type="date"
                value={date}
                max={todayIso()}
                onChange={(event) => setDate(event.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="manual-transaction-side" className="text-xs">
                Side *
              </Label>
              <Select value={side} onValueChange={(value) => setSide(value as Side)}>
                <SelectTrigger id="manual-transaction-side">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SIDES.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {isAssetBacked && (
            <div className="space-y-3">
              <div className="relative space-y-1.5">
                <Label htmlFor="manual-transaction-asset" className="text-xs">
                  Asset *
                </Label>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="manual-transaction-asset"
                    value={assetQuery}
                    onChange={(event) => updateAssetQuery(event.target.value)}
                    onFocus={() => {
                      if (searchResults.length > 0) setShowSearch(true);
                    }}
                    onBlur={() => window.setTimeout(() => setShowSearch(false), 150)}
                    placeholder="Search ticker or type a symbol"
                    className="pl-9"
                  />
                </div>
                {selectedAsset && (
                  <p className="text-xs text-muted-foreground">
                    {selectedAsset.name} - {selectedAsset.exchange}
                  </p>
                )}
                {!selectedAsset && selectedTicker && (
                  <p className="text-xs text-muted-foreground">
                    Using typed ticker {selectedTicker}
                  </p>
                )}
                {searchLoading && <p className="text-xs text-muted-foreground">Searching...</p>}
                {showSearch && searchResults.length > 0 && (
                  <div className="absolute z-50 mt-1 w-full rounded-md border border-border/50 bg-popover shadow-lg">
                    {searchResults.map((asset) => (
                      <button
                        key={`${asset.ticker}-${asset.exchange}`}
                        type="button"
                        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-accent"
                        onMouseDown={() => selectAsset(asset)}
                      >
                        <div className="min-w-0 text-left">
                          <div className="font-mono font-medium">{asset.ticker}</div>
                          <div className="truncate text-xs text-muted-foreground">{asset.name}</div>
                        </div>
                        <div className="shrink-0 text-right text-xs text-muted-foreground">
                          <div>{asset.exchange}</div>
                          <div>
                            {asset.currency
                              ? `${asset.assetType} - ${asset.currency}`
                              : asset.assetType}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="manual-transaction-isin" className="text-xs">
                  {isEditing ? "ISIN (editable)" : "ISIN"}
                </Label>
                <Input
                  id="manual-transaction-isin"
                  value={isin}
                  onChange={(event) => setIsin(event.target.value)}
                  placeholder="Optional, e.g. FR0000120271"
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  Add or correct the ISIN for consistent transaction history.
                </p>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            {showsQuantity && (
              <div className="space-y-1.5">
                <Label htmlFor="manual-transaction-quantity" className="text-xs">
                  Quantity{requiresQuantity ? " *" : ""}
                </Label>
                <Input
                  id="manual-transaction-quantity"
                  type="number"
                  min="0"
                  step="0.000001"
                  value={quantity}
                  onChange={(event) => setQuantity(event.target.value)}
                  placeholder="0"
                />
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="manual-transaction-amount" className="text-xs">
                {side === "DIV" ? "Total received *" : "Amount *"}
              </Label>
              <Input
                id="manual-transaction-amount"
                type="number"
                min="0"
                step="0.01"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="0.00"
              />
              <p className="text-xs text-muted-foreground">{signedAmountHint}</p>
              {dividendPerShare != null && (
                <p className="font-mono text-xs text-muted-foreground">
                  Dividend/share: {dividendPerShare.toFixed(4)}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="manual-transaction-commission" className="text-xs">
                Commission
              </Label>
              <Input
                id="manual-transaction-commission"
                type="number"
                min="0"
                step="0.01"
                value={commission}
                onChange={(event) => setCommission(event.target.value)}
                placeholder="0.00"
              />
            </div>
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
              {loading ? (
                <TextShimmer>{isEditing ? "Saving" : "Adding"}</TextShimmer>
              ) : isEditing ? (
                "Save changes"
              ) : (
                "Add transaction"
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
