"use client";

import { useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { ThesisCenteredModal } from "@/components/thesis-centered-modal";
import { useTheses } from "@/hooks/use-theses";
import { ThesisContext } from "@/contexts/thesis-context";
import type { Thesis } from "@/lib/thesis";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { theses, addThesis, updateThesis, deleteThesis } = useTheses();
  const [selectedThesisId, setSelectedThesisId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createPrefill, setCreatePrefill] = useState<Partial<
    Pick<Thesis, "title" | "summary" | "tickers" | "horizon" | "tags">
  > | null>(null);

  const openDrawer = (id: string) => setSelectedThesisId(id);
  const openModal = (
    thesis?: Thesis,
    prefill?: Partial<Pick<Thesis, "title" | "summary" | "tickers" | "horizon" | "tags">>,
  ) => {
    if (thesis) {
      setSelectedThesisId(thesis.id);
      return;
    }
    setCreatePrefill(prefill ?? null);
    setCreateOpen(true);
  };

  const selectedThesis = selectedThesisId
    ? (theses.find((t) => t.id === selectedThesisId) ?? null)
    : null;

  return (
    <ThesisContext.Provider
      value={{ theses, addThesis, updateThesis, deleteThesis, openDrawer, openModal }}
    >
      <AppSidebar>
        {/* Below md the sticky top bar already occupies 3.5rem of the viewport,
            so a full-height wrapper here would push every short page into scroll. */}
        <div className="flex min-h-[calc(100dvh-3.5rem)] flex-col md:min-h-screen">{children}</div>
      </AppSidebar>
      <ThesisCenteredModal
        open={!!selectedThesisId || createOpen}
        onOpenChange={(o) => {
          if (!o) {
            setSelectedThesisId(null);
            setCreateOpen(false);
            setCreatePrefill(null);
          }
        }}
        thesis={selectedThesis}
        createPrefill={createPrefill}
        onSave={(data) => {
          if (selectedThesisId) updateThesis(selectedThesisId, data);
          else addThesis(data);
          setSelectedThesisId(null);
          setCreateOpen(false);
          setCreatePrefill(null);
        }}
        onDelete={(id) => {
          deleteThesis(id);
          setSelectedThesisId(null);
          setCreatePrefill(null);
        }}
      />
    </ThesisContext.Provider>
  );
}
