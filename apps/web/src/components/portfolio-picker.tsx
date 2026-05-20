"use client";

import { useState, useEffect } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { ChevronDown, Briefcase } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

interface Portfolio {
  id: string;
  name: string;
}

interface PortfolioPickerProps {
  collapsed?: boolean;
}

export function PortfolioPicker({ collapsed = false }: PortfolioPickerProps) {
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const selectedId = searchParams.get("portfolioId") ?? "";

  useEffect(() => {
    supabase
      .from("portfolios")
      .select("id,name")
      .order("created_at", { ascending: true })
      .then(({ data }) => {
        if (data) setPortfolios(data as Portfolio[]);
      });
  }, []);

  const selected = portfolios.find((p) => p.id === selectedId) ?? portfolios[0] ?? null;

  function selectPortfolio(id: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("portfolioId", id);
    router.push(`${pathname}?${params.toString()}`);
    setOpen(false);
  }

  if (portfolios.length === 0) return null;

  if (collapsed) {
    return (
      <div className="flex justify-center px-2 py-1">
        <button
          type="button"
          title={selected?.name ?? "Select portfolio"}
          className="grid h-8 w-8 place-items-center rounded-md text-foreground-muted hover:bg-surface-2 hover:text-foreground"
          onClick={() => setOpen((o) => !o)}
        >
          <Briefcase className="h-4 w-4" />
        </button>
        {open && (
          <div className="absolute left-[68px] top-[120px] z-50 min-w-[200px] rounded-lg border border-hairline bg-surface shadow-lg">
            <PortfolioList portfolios={portfolios} selectedId={selectedId} onSelect={selectPortfolio} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="relative px-2 py-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-hairline bg-surface-2 px-2.5 py-1.5 text-sm text-foreground hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex min-w-0 items-center gap-2">
          <Briefcase className="h-3.5 w-3.5 shrink-0 text-foreground-muted" />
          <span className="truncate font-medium">{selected?.name ?? "Select portfolio"}</span>
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-foreground-muted transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <>
          {/* Click-away overlay */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 right-0 top-full z-50 mt-1 rounded-lg border border-hairline bg-surface shadow-lg">
            <PortfolioList portfolios={portfolios} selectedId={selectedId} onSelect={selectPortfolio} />
          </div>
        </>
      )}
    </div>
  );
}

function PortfolioList({
  portfolios,
  selectedId,
  onSelect,
}: {
  portfolios: Portfolio[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <ul className="py-1">
      {portfolios.map((p) => (
        <li key={p.id}>
          <button
            type="button"
            onClick={() => onSelect(p.id)}
            className={`flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-surface-2 ${
              p.id === selectedId ? "font-medium text-foreground" : "text-foreground-muted"
            }`}
          >
            <span className="truncate">{p.name}</span>
            {p.id === selectedId && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-foreground" />}
          </button>
        </li>
      ))}
    </ul>
  );
}
