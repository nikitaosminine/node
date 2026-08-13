import { useState, useEffect, useRef } from "react";
import {
  X,
  Pencil,
  Trash2,
  Check,
  Paperclip,
  FileText,
  FileImage,
  ChevronLeft,
  ChevronRight,
  ZoomIn,
} from "lucide-react";
import { DialogClose } from "@/components/ui/dialog";
import { Thesis, ThesisAttachment, ThesisConviction, ThesisStatus, STOCKS } from "@/lib/thesis";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { ThesisBody } from "./thesis-body";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  thesis: Thesis | null;
  createPrefill?: Partial<
    Pick<Thesis, "title" | "summary" | "tickers" | "horizon" | "tags">
  > | null;
  onSave: (data: Omit<Thesis, "id" | "createdAt">) => void;
  onDelete?: (id: string) => void;
}

const STATUS_CLASSES: Record<ThesisStatus, string> = {
  active: "bg-foreground/10 text-foreground",
  "playing-out": "bg-positive/15 text-positive",
  invalidated: "bg-negative/15 text-negative",
  closed: "bg-muted text-muted-foreground",
};

const STATUS_LABELS: Record<ThesisStatus, string> = {
  active: "Active",
  "playing-out": "Playing out",
  invalidated: "Invalidated",
  closed: "Closed",
};

const CONVICTION_COLORS: Record<ThesisConviction, string> = {
  low: "oklch(0.60 0.02 264)",
  med: "oklch(0.78 0.14 75)",
  high: "oklch(0.80 0.15 250)",
};

const EVIDENCE_COLORS = {
  confirm: "oklch(0.72 0.19 150)",
  warn: "oklch(0.72 0.19 30)",
  neutral: "oklch(0.60 0.02 264)",
};

const STATUS_OPTIONS: { value: ThesisStatus; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "playing-out", label: "Playing out" },
  { value: "invalidated", label: "Invalidated" },
  { value: "closed", label: "Closed" },
];

const CONVICTION_OPTIONS: { value: ThesisConviction; label: string }[] = [
  { value: "low", label: "L" },
  { value: "med", label: "M" },
  { value: "high", label: "H" },
];

function ConvictionDots({ level }: { level: ThesisConviction }) {
  const filled = level === "low" ? 1 : level === "med" ? 2 : 3;
  const color = CONVICTION_COLORS[level];
  return (
    <span className="inline-flex gap-0.5 items-center">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-2 w-2 rounded-full"
          style={{ background: i < filled ? color : "oklch(0.30 0.02 264)" }}
        />
      ))}
    </span>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function isCsv(type: string, name: string): boolean {
  return type === "text/csv" || name.toLowerCase().endsWith(".csv");
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells: string[] = [];
    let cur = "";
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuote && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuote = !inQuote;
      } else if (ch === "," && !inQuote) {
        cells.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    cells.push(cur);
    rows.push(cells);
  }
  return rows;
}

export function ThesisCenteredModal({
  open,
  onOpenChange,
  thesis,
  createPrefill,
  onSave,
  onDelete,
}: Props) {
  const isCreate = thesis === null;
  const [mode, setMode] = useState<"view" | "edit">(isCreate ? "edit" : "view");

  // Form state
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [conviction, setConviction] = useState<ThesisConviction>("med");
  const [status, setStatus] = useState<ThesisStatus>("active");
  const [tickers, setTickers] = useState<string[]>([]);
  const [tickerSearch, setTickerSearch] = useState("");
  const [showTickerDropdown, setShowTickerDropdown] = useState(false);
  const [horizon, setHorizon] = useState("");
  const [tags, setTags] = useState("");
  const tickerRef = useRef<HTMLDivElement>(null);

  // Attachment state
  const [existingAttachments, setExistingAttachments] = useState<ThesisAttachment[]>([]);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [removedPaths, setRemovedPaths] = useState<string[]>([]);
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Lightbox state
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState(0);

  // Spreadsheet preview state
  const [sheetPreview, setSheetPreview] = useState<{ name: string; rows: string[][] } | null>(null);
  const [sheetLoading, setSheetLoading] = useState(false);

  // Reset form + mode when modal opens or thesis changes
  useEffect(() => {
    if (!open) return;
    const src = thesis;
    setMode(src ? "view" : "edit");
    if (src) {
      setTitle(src.title);
      setSummary(src.summary);
      setReasoning(
        src.body
          .filter((b) => b.type === "p")
          .map((b) => b.content as string)
          .join("\n\n"),
      );
      setConviction(src.conviction);
      setStatus(src.status);
      setTickers(src.tickers);
      setHorizon(src.horizon);
      setTags(src.tags.join(", "));
      setExistingAttachments(src.attachments ?? []);
    } else {
      setTitle(createPrefill?.title ?? "");
      setSummary(createPrefill?.summary ?? "");
      setReasoning("");
      setConviction("med");
      setStatus("active");
      setTickers(createPrefill?.tickers ?? []);
      setHorizon(createPrefill?.horizon ?? "");
      setTags((createPrefill?.tags ?? []).join(", "));
      setExistingAttachments([]);
    }
    setPendingFiles([]);
    setRemovedPaths([]);
    setTickerSearch("");
    setLightboxSrc(null);
    setSheetPreview(null);
  }, [open, thesis, createPrefill]);

  // Generate signed URLs when viewing attachments
  useEffect(() => {
    if (!open || mode !== "view" || !thesis?.attachments?.length) return;
    const generate = async () => {
      const urls: Record<string, string> = {};
      await Promise.all(
        (thesis.attachments ?? []).map(async (att) => {
          const { data } = await supabase.storage
            .from("thesis-attachments")
            .createSignedUrl(att.path, 3600);
          if (data) urls[att.path] = data.signedUrl;
        }),
      );
      setSignedUrls(urls);
    };
    generate();
  }, [open, mode, thesis]);

  // Close ticker dropdown on outside click
  useEffect(() => {
    if (!showTickerDropdown) return;
    const handler = (e: MouseEvent) => {
      if (tickerRef.current && !tickerRef.current.contains(e.target as Node))
        setShowTickerDropdown(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showTickerDropdown]);

  const filteredStocks = STOCKS.filter(
    (s) =>
      (s.ticker.toLowerCase().includes(tickerSearch.toLowerCase()) ||
        s.name.toLowerCase().includes(tickerSearch.toLowerCase())) &&
      !tickers.includes(s.ticker),
  ).slice(0, 8);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length) setPendingFiles((prev) => [...prev, ...files]);
    e.target.value = "";
  };

  const removeExistingAttachment = (att: ThesisAttachment) => {
    setExistingAttachments((prev) => prev.filter((a) => a.path !== att.path));
    setRemovedPaths((prev) => [...prev, att.path]);
  };

  const removePendingFile = (index: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSave = async () => {
    if (!title.trim()) return;
    setUploading(true);

    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      // Upload pending files to storage
      const newAttachments: ThesisAttachment[] = [];
      for (const file of pendingFiles) {
        const path = `${user!.id}/${crypto.randomUUID()}-${file.name}`;
        const { error } = await supabase.storage.from("thesis-attachments").upload(path, file);
        if (!error) {
          newAttachments.push({ path, name: file.name, type: file.type, size: file.size });
        }
      }

      // Delete removed attachments from storage
      if (removedPaths.length) {
        await supabase.storage.from("thesis-attachments").remove(removedPaths);
      }

      const body = reasoning.trim() ? [{ type: "p" as const, content: reasoning.trim() }] : [];

      onSave({
        title: title.trim(),
        summary: summary.trim(),
        conviction,
        status,
        tickers,
        body,
        evidence: thesis?.evidence ?? [],
        horizon: horizon.trim(),
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        attachments: [...existingAttachments, ...newAttachments],
      });
      onOpenChange(false);
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = () => {
    if (thesis && onDelete) {
      onDelete(thesis.id);
      onOpenChange(false);
    }
  };

  const handleCancel = () => {
    if (isCreate) {
      onOpenChange(false);
    } else {
      setMode("view");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        hideCloseButton
        className="sm:max-w-3xl max-h-[88dvh] flex flex-col p-0 gap-0 overflow-hidden"
      >
        {/* ── VIEW mode ── */}
        {mode === "view" && thesis && (
          <>
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-border/50 shrink-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_CLASSES[thesis.status]}`}
                >
                  {STATUS_LABELS[thesis.status]}
                </span>
                <ConvictionDots level={thesis.conviction} />
                <span className="text-xs text-muted-foreground capitalize">
                  {thesis.conviction} conviction
                </span>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => setMode("edit")}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                {onDelete && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-negative"
                    onClick={handleDelete}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
                <DialogClose asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </DialogClose>
              </div>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto">
              <div className="px-6 py-5 space-y-6">
                <div>
                  <h1 className="text-2xl font-semibold tracking-tight">{thesis.title}</h1>
                  {thesis.summary && (
                    <p className="text-sm text-muted-foreground mt-1.5">{thesis.summary}</p>
                  )}
                  <div className="flex gap-4 text-xs text-muted-foreground mt-2">
                    {thesis.horizon && (
                      <span>
                        Horizon:{" "}
                        <span className="text-foreground font-medium">{thesis.horizon}</span>
                      </span>
                    )}
                    <span>
                      Added: <span className="text-foreground font-medium">{thesis.createdAt}</span>
                    </span>
                  </div>
                </div>

                {thesis.tickers.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                      Linked positions
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {thesis.tickers.map((tk) => (
                        <span
                          key={tk}
                          className="inline-flex items-center rounded bg-muted px-2 py-0.5 font-mono text-[11px] font-medium tabular-nums"
                        >
                          {tk}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {thesis.body.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                      Reasoning
                    </p>
                    <ThesisBody blocks={thesis.body} />
                  </div>
                )}

                {/* Attachments — view */}
                {(thesis.attachments ?? []).length > 0 && (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                      Attachments
                    </p>
                    <div className="flex flex-wrap gap-3">
                      {(thesis.attachments ?? []).map((att, idx) => {
                        const url = signedUrls[att.path];
                        const isImage = att.type.startsWith("image/");
                        const isCsvFile = isCsv(att.type, att.name);
                        const imageAtts = (thesis.attachments ?? []).filter((a) =>
                          a.type.startsWith("image/"),
                        );

                        if (isImage) {
                          return url ? (
                            <button
                              key={att.path}
                              onClick={() => {
                                setLightboxIndex(imageAtts.indexOf(att));
                                setLightboxSrc(url);
                              }}
                              className="relative group block"
                            >
                              <img
                                src={url}
                                alt={att.name}
                                className="h-28 w-28 object-cover rounded-md border border-border/50 transition-opacity group-hover:opacity-70"
                              />
                              <span className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                                <ZoomIn className="h-5 w-5 text-white drop-shadow" />
                              </span>
                            </button>
                          ) : (
                            <div
                              key={att.path}
                              className="h-28 w-28 rounded-md border border-border/50 bg-muted animate-pulse"
                            />
                          );
                        }

                        if (isCsvFile) {
                          return (
                            <button
                              key={att.path}
                              disabled={!url || sheetLoading}
                              onClick={async () => {
                                if (!url) return;
                                setSheetLoading(true);
                                try {
                                  const text = await fetch(url).then((r) => r.text());
                                  setSheetPreview({ name: att.name, rows: parseCsv(text) });
                                } finally {
                                  setSheetLoading(false);
                                }
                              }}
                              className="inline-flex items-center gap-2 px-3 py-2 rounded-md border border-border/50 bg-muted/30 text-xs hover:bg-muted/60 transition-colors disabled:opacity-50"
                            >
                              <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                              <span className="truncate max-w-[160px]">{att.name}</span>
                              <span className="text-muted-foreground/60 shrink-0">
                                {formatSize(att.size)}
                              </span>
                            </button>
                          );
                        }

                        return (
                          <a
                            key={att.path}
                            href={url}
                            download={att.name}
                            className="inline-flex items-center gap-2 px-3 py-2 rounded-md border border-border/50 bg-muted/30 text-xs hover:bg-muted/60 transition-colors"
                          >
                            <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                            <span className="truncate max-w-[160px]">{att.name}</span>
                            <span className="text-muted-foreground/60 shrink-0">
                              {formatSize(att.size)}
                            </span>
                          </a>
                        );
                      })}
                    </div>
                  </div>
                )}

                {thesis.evidence.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                      Agent evidence log
                    </p>
                    <div className="border-l border-border ml-2 space-y-3 pl-4">
                      {thesis.evidence.map((ev) => (
                        <div key={ev.id} className="relative">
                          <span
                            className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-card"
                            style={{ background: EVIDENCE_COLORS[ev.type] }}
                          />
                          <p className="text-sm leading-snug">{ev.text}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">{ev.date}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {thesis.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {thesis.tags.map((tag) => (
                      <span
                        key={tag}
                        className="inline-flex items-center px-2 py-0.5 rounded-full bg-muted/60 text-xs text-muted-foreground"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {/* ── EDIT / CREATE mode ── */}
        {mode === "edit" && (
          <>
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-border/50 shrink-0">
              <h2 className="text-base font-semibold">{isCreate ? "New take" : "Edit take"}</h2>
              <DialogClose asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </DialogClose>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Title</Label>
                <Input
                  placeholder="e.g. AI infrastructure supercycle"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="h-9"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">
                  Summary <span className="text-muted-foreground/50">(one line)</span>
                </Label>
                <Input
                  placeholder="The core thesis in one sentence"
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  className="h-9"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Reasoning</Label>
                <textarea
                  placeholder="Expand on your thesis. What's the key insight? What could invalidate it?"
                  value={reasoning}
                  onChange={(e) => setReasoning(e.target.value)}
                  className="w-full min-h-[120px] resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              </div>

              <div ref={tickerRef} className="space-y-1.5 relative">
                <Label className="text-xs text-muted-foreground">Tickers</Label>
                <div className="flex flex-wrap gap-1.5 p-2 rounded-md border border-input min-h-9 bg-transparent">
                  {tickers.map((tk) => (
                    <span
                      key={tk}
                      className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 font-mono text-[11px] font-medium tabular-nums"
                    >
                      {tk}
                      <button
                        onClick={() => setTickers((prev) => prev.filter((t) => t !== tk))}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                  <input
                    placeholder={tickers.length === 0 ? "Search ticker or company…" : ""}
                    value={tickerSearch}
                    onChange={(e) => {
                      setTickerSearch(e.target.value);
                      setShowTickerDropdown(true);
                    }}
                    onFocus={() => setShowTickerDropdown(true)}
                    className="flex-1 min-w-[140px] bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                  />
                </div>
                {showTickerDropdown && tickerSearch && filteredStocks.length > 0 && (
                  <div className="absolute z-10 w-full top-full mt-1 rounded-lg border border-border/50 bg-card shadow-lg p-1 space-y-0.5">
                    {filteredStocks.map((s) => (
                      <button
                        key={s.ticker}
                        onClick={() => {
                          setTickers((prev) => [...prev, s.ticker]);
                          setTickerSearch("");
                          setShowTickerDropdown(false);
                        }}
                        className="w-full text-left px-2.5 py-2.5 md:py-1.5 rounded text-xs hover:bg-muted/50 flex items-center justify-between"
                      >
                        <span className="font-mono text-[11px] font-medium tabular-nums">
                          {s.ticker}
                        </span>
                        <span className="text-muted-foreground">{s.name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Conviction</Label>
                  <div className="flex gap-1">
                    {CONVICTION_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => setConviction(opt.value)}
                        className={`flex-1 h-9 rounded text-sm font-medium transition-colors border ${
                          conviction === opt.value
                            ? "border-foreground bg-foreground text-background"
                            : "border-border text-muted-foreground hover:text-foreground hover:border-border/80"
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Status</Label>
                  <select
                    value={status}
                    onChange={(e) => setStatus(e.target.value as ThesisStatus)}
                    className="w-full h-9 rounded-md border border-input bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    {STATUS_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Horizon</Label>
                  <Input
                    placeholder="e.g. 12 months"
                    value={horizon}
                    onChange={(e) => setHorizon(e.target.value)}
                    className="h-9"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    Tags <span className="text-muted-foreground/50">(comma separated)</span>
                  </Label>
                  <Input
                    placeholder="e.g. AI, semiconductors"
                    value={tags}
                    onChange={(e) => setTags(e.target.value)}
                    className="h-9"
                  />
                </div>
              </div>

              {/* Attachments — edit */}
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Attachments</Label>
                <div className="flex flex-wrap gap-2 p-2 rounded-md border border-input min-h-9 bg-transparent">
                  {existingAttachments.map((att) => (
                    <span
                      key={att.path}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-muted text-xs"
                    >
                      {att.type.startsWith("image/") ? (
                        <FileImage className="h-3 w-3 text-muted-foreground" />
                      ) : (
                        <FileText className="h-3 w-3 text-muted-foreground" />
                      )}
                      <span className="max-w-[120px] truncate">{att.name}</span>
                      <button
                        onClick={() => removeExistingAttachment(att)}
                        className="text-muted-foreground hover:text-foreground ml-0.5"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                  {pendingFiles.map((f, i) => (
                    <span
                      key={i}
                      className="inline-flex items-center gap-1 rounded bg-foreground/10 px-2 py-0.5 text-xs text-foreground"
                    >
                      {f.type.startsWith("image/") ? (
                        <FileImage className="h-3 w-3" />
                      ) : (
                        <FileText className="h-3 w-3" />
                      )}
                      <span className="max-w-[120px] truncate">{f.name}</span>
                      <span className="text-foreground/60">{formatSize(f.size)}</span>
                      <button
                        onClick={() => removePendingFile(i)}
                        className="ml-0.5 hover:text-foreground/70"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                  >
                    <Paperclip className="h-3 w-3" />
                    Attach file
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt"
                    onChange={handleFileSelect}
                    className="sr-only"
                  />
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-border/50 shrink-0">
              <Button variant="ghost" size="sm" onClick={handleCancel} disabled={uploading}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleSave} disabled={!title.trim() || uploading}>
                {uploading ? (
                  <span className="flex items-center gap-1.5">
                    <span className="h-3.5 w-3.5 rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground animate-spin" />
                    Uploading…
                  </span>
                ) : (
                  <>
                    <Check className="h-3.5 w-3.5 mr-1.5" />
                    {isCreate ? "Add take" : "Save changes"}
                  </>
                )}
              </Button>
            </div>
          </>
        )}
      </DialogContent>

      {/* Image lightbox */}
      {lightboxSrc && thesis && (
        <div
          className="fixed inset-0 z-[60] bg-black/90 flex items-center justify-center"
          onClick={() => setLightboxSrc(null)}
        >
          <button
            className="absolute top-4 right-4 text-white/60 hover:text-white transition-colors"
            onClick={() => setLightboxSrc(null)}
          >
            <X className="h-6 w-6" />
          </button>
          {/* Prev / next arrows when multiple images */}
          {(() => {
            const imageAtts = (thesis.attachments ?? []).filter((a) => a.type.startsWith("image/"));
            return imageAtts.length > 1 ? (
              <>
                <button
                  className="absolute left-4 top-1/2 -translate-y-1/2 text-white/60 hover:text-white transition-colors"
                  onClick={(e) => {
                    e.stopPropagation();
                    const prev = (lightboxIndex - 1 + imageAtts.length) % imageAtts.length;
                    setLightboxIndex(prev);
                    setLightboxSrc(signedUrls[imageAtts[prev].path]);
                  }}
                >
                  <ChevronLeft className="h-8 w-8" />
                </button>
                <button
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-white/60 hover:text-white transition-colors"
                  onClick={(e) => {
                    e.stopPropagation();
                    const next = (lightboxIndex + 1) % imageAtts.length;
                    setLightboxIndex(next);
                    setLightboxSrc(signedUrls[imageAtts[next].path]);
                  }}
                >
                  <ChevronRight className="h-8 w-8" />
                </button>
              </>
            ) : null;
          })()}
          <img
            src={lightboxSrc}
            alt=""
            className="max-h-[90vh] max-w-[90vw] object-contain rounded shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      {/* Spreadsheet preview overlay */}
      {sheetPreview && (
        <div
          className="fixed inset-0 z-[60] bg-black/80 flex items-center justify-center p-4 sm:p-6"
          onClick={() => setSheetPreview(null)}
        >
          <div
            className="bg-card rounded-xl border border-border shadow-2xl flex flex-col max-h-[85dvh] max-w-[90vw] w-full overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
              <span className="text-sm font-medium truncate">{sheetPreview.name}</span>
              <button
                className="text-muted-foreground hover:text-foreground transition-colors ml-4 shrink-0"
                onClick={() => setSheetPreview(null)}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="overflow-auto flex-1">
              <table className="text-xs border-collapse w-full">
                <tbody>
                  {sheetPreview.rows.slice(0, 200).map((row, ri) => (
                    <tr
                      key={ri}
                      className={
                        ri === 0
                          ? "bg-muted/40 font-semibold sticky top-0"
                          : "border-t border-border/40 hover:bg-muted/20"
                      }
                    >
                      {row.map((cell, ci) => (
                        <td
                          key={ci}
                          className="px-3 py-1.5 whitespace-nowrap border-r border-border/30 last:border-r-0 font-mono tabular-nums"
                        >
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {sheetPreview.rows.length > 200 && (
                <p className="text-xs text-muted-foreground text-center py-3">
                  Showing first 200 rows of {sheetPreview.rows.length}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}
