"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, FileText, Upload } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { TextShimmer } from "@/components/loading-ui/text-shimmer";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { API_BASE_URL } from "@/lib/api";
import { DEFAULT_PORTFOLIO_CURRENCY, formatCurrency } from "@/lib/currency";
import {
  aggregateIncomeByMonth,
  buildTransactionInserts,
  coercePreviewRow,
  foreignCurrencies,
  type PreviewResponse,
  type ReviewRow,
} from "@/lib/expense-import";

interface CategoryOption {
  id: string;
  display_name: string;
  pfc_primary: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  onImported: () => void;
}

type Stage = "idle" | "selected" | "reading" | "normalizing" | "complete";

const PROGRESS: Record<Stage, { label: string; value: number }> = {
  idle: { label: "Select a CSV to begin", value: 0 },
  selected: { label: "Ready to preview", value: 15 },
  reading: { label: "Reading CSV", value: 30 },
  normalizing: { label: "Normalizing with AI", value: 75 },
  complete: { label: "Ready to review", value: 100 },
};

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Not authenticated");
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

export function CsvImportExpenses({ open, onOpenChange, userId, onImported }: Props) {
  const baseCurrency = DEFAULT_PORTFOLIO_CURRENCY;
  const [step, setStep] = useState<"upload" | "review">("upload");
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState<Stage>("idle");
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [categories, setCategories] = useState<CategoryOption[]>([]);

  const reset = () => {
    setStep("upload");
    setFile(null);
    setLoading(false);
    setStage("idle");
    setRows([]);
    setErrors([]);
  };

  useEffect(() => {
    if (!open) return;
    supabase
      .from("expense_categories")
      .select("id, display_name, pfc_primary")
      .order("display_name", { ascending: true })
      .then(({ data }) => setCategories((data as CategoryOption[]) ?? []));
  }, [open]);

  const categoryIdByPrimary = categories.reduce<Record<string, string>>((acc, c) => {
    if (!(c.pfc_primary in acc)) acc[c.pfc_primary] = c.id;
    return acc;
  }, {});

  const selectFile = (next: File | null) => {
    setFile(next);
    setStage(next ? "selected" : "idle");
  };

  const handleDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    setDragOver(false);
    const dropped = event.dataTransfer.files[0];
    if (dropped && dropped.name.toLowerCase().endsWith(".csv")) selectFile(dropped);
    else toast.error("Please drop a CSV file");
  }, []);

  const handlePreview = async () => {
    if (!file) return;
    setLoading(true);
    try {
      setStage("reading");
      const csv = await file.text();
      const headers = await authHeaders();
      setStage("normalizing");
      const res = await fetch(`${API_BASE_URL}/api/expenses/import/preview`, {
        method: "POST",
        headers,
        body: JSON.stringify({ csv }),
      });
      const data = (await res.json()) as PreviewResponse & { error?: string };
      if (!res.ok) throw new Error(data.error || "Preview failed");
      const reviewRows = (data.rows ?? []).map((r) =>
        coercePreviewRow(r, categoryIdByPrimary, baseCurrency),
      );
      setRows(reviewRows);
      setErrors(data.errors ?? []);
      setStage("complete");
      window.setTimeout(() => setStep("review"), 200);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to parse CSV");
      setStage(file ? "selected" : "idle");
    } finally {
      setLoading(false);
    }
  };

  const patchRow = (index: number, patch: Partial<ReviewRow>) => {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const handleConfirm = async () => {
    setLoading(true);
    try {
      const inserts = buildTransactionInserts(rows, userId, baseCurrency);
      const incomeUpserts = aggregateIncomeByMonth(rows, userId, baseCurrency);

      // Dedup against already-imported rows that carry a bank reference (external_id).
      const refs = inserts.map((r) => r.external_id).filter((r): r is string => r != null);
      let existing = new Set<string>();
      if (refs.length > 0) {
        const { data } = await supabase
          .from("expense_transactions")
          .select("external_id")
          .eq("source", "csv")
          .in("external_id", refs);
        existing = new Set((data ?? []).map((d) => d.external_id as string));
      }
      const toInsert = inserts.filter((r) => r.external_id == null || !existing.has(r.external_id));
      const skipped = inserts.length - toInsert.length;

      if (toInsert.length > 0) {
        const { error } = await supabase.from("expense_transactions").insert(toInsert);
        if (error) throw error;
      }
      if (incomeUpserts.length > 0) {
        const { error } = await supabase
          .from("expense_income")
          .upsert(incomeUpserts, { onConflict: "user_id,month" });
        if (error) throw error;
      }

      const parts = [`${toInsert.length} expense${toInsert.length === 1 ? "" : "s"} imported`];
      if (incomeUpserts.length > 0) parts.push(`income set for ${incomeUpserts.length} month(s)`);
      if (skipped > 0) parts.push(`${skipped} duplicate(s) skipped`);
      toast.success(parts.join(" · "));
      reset();
      onOpenChange(false);
      onImported();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to import");
    } finally {
      setLoading(false);
    }
  };

  const included = rows.filter((r) => r.include);
  const foreign = foreignCurrencies(included, baseCurrency);

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) reset();
        onOpenChange(value);
      }}
    >
      <DialogContent className={step === "review" ? "sm:max-w-4xl" : "sm:max-w-md"}>
        <DialogHeader>
          <DialogTitle>{step === "upload" ? "Import expenses" : "Review import"}</DialogTitle>
          <DialogDescription>
            {step === "upload"
              ? "Upload a bank or card CSV. Rows are categorized by AI before import — you confirm first."
              : `${included.length} of ${rows.length} rows selected. Edit categories and uncheck anything you don't want.`}
          </DialogDescription>
        </DialogHeader>

        {step === "upload" && (
          <div className="space-y-4">
            <label
              onDragOver={(event) => {
                event.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 transition-colors ${
                dragOver
                  ? "border-foreground bg-foreground/5"
                  : "border-hairline hover:border-foreground/30"
              }`}
            >
              {file ? (
                <div className="flex items-center gap-2 text-sm">
                  <FileText className="h-4 w-4 text-foreground" />
                  <span>{file.name}</span>
                </div>
              ) : (
                <>
                  <Upload className="mb-2 h-7 w-7 text-foreground-muted" />
                  <p className="text-sm text-foreground-muted">
                    Drop your bank CSV or click to browse
                  </p>
                  <p className="mt-1 text-xs text-foreground-muted/60">
                    Any column layout is accepted
                  </p>
                </>
              )}
              <input
                type="file"
                accept=".csv"
                className="hidden"
                onChange={(event) => selectFile(event.target.files?.[0] ?? null)}
              />
            </label>

            {(file || loading) && (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3 text-xs text-foreground-muted">
                  <span className="truncate">{PROGRESS[stage].label}</span>
                  <span className="tabular-nums">{PROGRESS[stage].value}%</span>
                </div>
                <Progress value={PROGRESS[stage].value} />
              </div>
            )}

            <Button onClick={handlePreview} disabled={!file || loading} className="w-full">
              {loading ? <TextShimmer>Analyzing</TextShimmer> : "Preview expenses"}
            </Button>
          </div>
        )}

        {step === "review" && (
          <div className="space-y-4">
            {errors.length > 0 && (
              <div className="rounded-md border border-destructive/20 bg-destructive/10 p-3">
                {errors.map((error, index) => (
                  <p key={index} className="flex items-start gap-1.5 text-xs text-destructive/80">
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {error}
                  </p>
                ))}
              </div>
            )}
            {foreign.length > 0 && (
              <p className="text-xs text-negative">
                Detected {foreign.join(", ")} — these will be imported as {baseCurrency} for now
                (single-currency v1).
              </p>
            )}

            <div className="max-h-[420px] overflow-auto rounded-md border border-hairline">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead className="text-xs">Date</TableHead>
                    <TableHead className="text-xs">Merchant</TableHead>
                    <TableHead className="text-xs">Category</TableHead>
                    <TableHead className="text-xs">Type</TableHead>
                    <TableHead className="text-right text-xs">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row, index) => (
                    <TableRow
                      key={`${row.posted_at}-${row.merchant_name}-${index}`}
                      className={row.include ? "" : "opacity-40"}
                    >
                      <TableCell>
                        <Checkbox
                          checked={row.include}
                          onCheckedChange={(value) => patchRow(index, { include: value === true })}
                          aria-label="Include row"
                        />
                      </TableCell>
                      <TableCell className="font-mono text-xs">{row.posted_at}</TableCell>
                      <TableCell
                        className="max-w-[200px] truncate text-xs"
                        title={row.merchant_name}
                      >
                        {row.merchant_name}
                        {row.confidence < 0.5 && (
                          <span className="ml-1 text-[10px] text-negative">low confidence</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Select
                          value={row.category_id ?? "none"}
                          onValueChange={(value) =>
                            patchRow(index, { category_id: value === "none" ? null : value })
                          }
                        >
                          <SelectTrigger className="h-7 w-[150px] text-xs">
                            <SelectValue placeholder="Uncategorized" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">Uncategorized</SelectItem>
                            {categories.map((c) => (
                              <SelectItem key={c.id} value={c.id}>
                                {c.display_name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell className="text-xs text-foreground-muted">
                        {row.kind === "income"
                          ? "Income"
                          : row.is_recurring
                            ? "Recurring"
                            : "Spend"}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {formatCurrency(row.amount, baseCurrency)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setStep("upload")} className="flex-1">
                Back
              </Button>
              <Button
                onClick={handleConfirm}
                disabled={loading || included.length === 0}
                className="flex-1"
              >
                {loading ? (
                  <TextShimmer>Importing</TextShimmer>
                ) : (
                  `Import ${included.length} row(s)`
                )}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
