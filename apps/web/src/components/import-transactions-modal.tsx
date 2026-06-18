"use client";

import { useCallback, useState } from "react";
import { AlertCircle, FileText, Upload } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { TextShimmer } from "@/components/loading-ui/text-shimmer";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { API_BASE_URL } from "@/lib/api";

type Side = "BUY" | "SELL" | "DEP" | "WD" | "DIV" | "FEE";

interface PreviewRow {
  date: string;
  symbol: string;
  isin: string | null;
  side: Side;
  quantity: string | null;
  net_amount: string | null;
  commission: string;
}

interface PreviewResponse {
  rows: PreviewRow[];
  errors: string[];
  columns_detected?: string[];
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  portfolioId: string;
  onImported: () => void;
}

const SIDE_COLOURS: Record<Side, string> = {
  BUY: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  SELL: "bg-red-500/10 text-red-400 border-red-500/20",
  DEP: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  WD: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  DIV: "bg-purple-500/10 text-purple-400 border-purple-500/20",
  FEE: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
};

type PreviewProgressStage =
  | "idle"
  | "selected"
  | "reading"
  | "sending"
  | "normalizing"
  | "parsing"
  | "complete";

const PREVIEW_PROGRESS: Record<PreviewProgressStage, { label: string; value: number }> = {
  idle: { label: "Select a CSV to begin", value: 0 },
  selected: { label: "Ready to preview", value: 15 },
  reading: { label: "Reading CSV", value: 25 },
  sending: { label: "Sending to normalizer", value: 40 },
  normalizing: { label: "Normalizing transactions", value: 75 },
  parsing: { label: "Parsing normalized rows", value: 90 },
  complete: { label: "Ready to review", value: 100 },
};

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Not authenticated");
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

export function ImportTransactionsModal({ open, onOpenChange, portfolioId, onImported }: Props) {
  const [step, setStep] = useState<"upload" | "review">("upload");
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewStage, setPreviewStage] = useState<PreviewProgressStage>("idle");

  const reset = () => {
    setStep("upload");
    setFile(null);
    setPreview(null);
    setLoading(false);
    setPreviewStage("idle");
  };

  const selectFile = (nextFile: File | null) => {
    setFile(nextFile);
    setPreview(null);
    setPreviewStage(nextFile ? "selected" : "idle");
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
      setPreviewStage("reading");
      const csv = await file.text();
      setPreviewStage("sending");
      const headers = await authHeaders();
      setPreviewStage("normalizing");
      const res = await fetch(
        `${API_BASE_URL}/api/portfolios/${portfolioId}/transactions/preview`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ csv }),
        },
      );
      setPreviewStage("parsing");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Preview failed");
      setPreview(data as PreviewResponse);
      setPreviewStage("complete");
      window.setTimeout(() => setStep("review"), 250);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to parse CSV");
      setPreviewStage(file ? "selected" : "idle");
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = async () => {
    if (!preview) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/portfolios/${portfolioId}/transactions`, {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({ rows: preview.rows }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Import failed");
      toast.success(`${data.inserted} transactions imported. Chart rebuild queued.`);
      reset();
      onOpenChange(false);
      onImported();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to import transactions");
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
      <DialogContent className={step === "review" ? "sm:max-w-4xl" : "sm:max-w-md"}>
        <DialogHeader>
          <DialogTitle>
            {step === "upload" ? "Import Transaction History" : "Review Transactions"}
          </DialogTitle>
          <DialogDescription>
            {step === "upload"
              ? "Upload a broker CSV. The rows will be normalized before import."
              : `${preview?.rows.length ?? 0} transactions detected. Review them before confirming.`}
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
                  : "border-border/50 hover:border-foreground/30"
              }`}
            >
              {file ? (
                <div className="flex items-center gap-2 text-sm">
                  <FileText className="h-4 w-4 text-foreground" />
                  <span>{file.name}</span>
                </div>
              ) : (
                <>
                  <Upload className="mb-2 h-7 w-7 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    Drop your broker CSV or click to browse
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground/60">
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
                <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span className="truncate">{PREVIEW_PROGRESS[previewStage].label}</span>
                  <span className="tabular-nums">{PREVIEW_PROGRESS[previewStage].value}%</span>
                </div>
                <Progress value={PREVIEW_PROGRESS[previewStage].value} />
              </div>
            )}

            <Button onClick={handlePreview} disabled={!file || loading} className="w-full">
              {loading ? <TextShimmer>Analyzing</TextShimmer> : "Preview transactions"}
            </Button>
          </div>
        )}

        {step === "review" && preview && (
          <div className="space-y-4">
            {preview.errors.length > 0 && (
              <div className="rounded-md border border-destructive/20 bg-destructive/10 p-3">
                <p className="mb-1 text-xs font-medium text-destructive">
                  Some rows need attention:
                </p>
                {preview.errors.map((error, index) => (
                  <p key={index} className="flex items-start gap-1.5 text-xs text-destructive/80">
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {error}
                  </p>
                ))}
              </div>
            )}

            <div className="max-h-[420px] overflow-auto rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Date</TableHead>
                    <TableHead className="text-xs">Symbol</TableHead>
                    <TableHead className="text-xs">ISIN</TableHead>
                    <TableHead className="text-xs">Side</TableHead>
                    <TableHead className="text-right text-xs">Qty</TableHead>
                    <TableHead className="text-right text-xs">Net Amount</TableHead>
                    <TableHead className="text-right text-xs">Commission</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.rows.map((row, index) => (
                    <TableRow key={`${row.date}-${row.side}-${index}`}>
                      <TableCell className="font-mono text-xs">{row.date}</TableCell>
                      <TableCell className="max-w-[180px] truncate text-xs" title={row.symbol}>
                        {row.symbol}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {row.isin ?? "-"}
                      </TableCell>
                      <TableCell>
                        <span
                          className={`inline-flex rounded border px-1.5 py-0.5 text-[10px] font-medium ${SIDE_COLOURS[row.side]}`}
                        >
                          {row.side}
                        </span>
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {row.quantity ?? "-"}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {row.net_amount ?? "-"}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {row.commission}
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
                disabled={loading || preview.rows.length === 0}
                className="flex-1"
              >
                {loading ? (
                  <TextShimmer>Importing</TextShimmer>
                ) : (
                  `Confirm ${preview.rows.length} transactions`
                )}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
