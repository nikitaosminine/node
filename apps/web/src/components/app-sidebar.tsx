"use client";

import { useState, useEffect, type ReactNode, Suspense } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Briefcase,
  ChevronDown,
  LayoutDashboard,
  BarChart3,
  TrendingUp,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
} from "lucide-react";
import { NodeLogo } from "@/components/node-logo";
import { ThemeSwitcher } from "@/components/ThemeSwitcher";
import { supabase } from "@/integrations/supabase/client";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Portfolio {
  id: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Detect active portfolio from the URL (needs useSearchParams)
// ---------------------------------------------------------------------------

function useActivePortfolioId(): string | null {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const fromParam = searchParams.get("portfolioId");
  if (fromParam) return fromParam;

  const match = pathname.match(/^\/portfolios\/([^/]+)/);
  if (match?.[1]) return match[1];

  return null;
}

// ---------------------------------------------------------------------------
// Sub-navigation items per portfolio
// ---------------------------------------------------------------------------

const SUB_ITEMS = [
  {
    label: "Overview",
    icon: <LayoutDashboard className="h-4 w-4" />,
    href: (id: string) => `/overview?portfolioId=${id}`,
    isActive: (pathname: string, searchParams: URLSearchParams, id: string) =>
      pathname.startsWith("/overview") && searchParams.get("portfolioId") === id,
  },
  {
    label: "Details",
    icon: <BarChart3 className="h-4 w-4" />,
    href: (id: string) => `/portfolios/${id}`,
    isActive: (pathname: string, _sp: URLSearchParams, id: string) =>
      pathname === `/portfolios/${id}`,
  },
  {
    label: "The Take",
    icon: <TrendingUp className="h-4 w-4" />,
    href: (_id: string) => `/the-take`,
    isActive: (pathname: string) => pathname.startsWith("/the-take"),
  },
] as const;

// ---------------------------------------------------------------------------
// Inner sidebar (needs useSearchParams / usePathname)
// ---------------------------------------------------------------------------

function SidebarInner({ collapsed }: { collapsed: boolean }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activePortfolioId = useActivePortfolioId();

  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [openId, setOpenId] = useState<string | null>(activePortfolioId);

  useEffect(() => {
    supabase
      .from("portfolios")
      .select("id,name")
      .order("created_at", { ascending: true })
      .then(({ data }) => {
        if (data) setPortfolios(data as Portfolio[]);
      });
  }, []);

  // Auto-expand when navigation changes active portfolio
  useEffect(() => {
    if (activePortfolioId) setOpenId(activePortfolioId);
  }, [activePortfolioId]);

  const isSettingsActive = pathname.startsWith("/settings");

  return (
    <nav className="flex flex-1 flex-col overflow-y-auto py-3">
      {/* ── PORTFOLIOS section ───────────────────────────────────────────── */}
      {!collapsed && (
        <div className="mb-1 px-4">
          <Link
            href="/portfolios"
            className="text-[11px] font-semibold uppercase tracking-widest text-foreground-muted/50 hover:text-foreground-muted transition-colors"
          >
            Portfolios
          </Link>
        </div>
      )}

      <ul className="flex flex-col gap-0.5 px-2">
        {portfolios.map((p) => {
          const isExpanded = openId === p.id;
          const isActive = activePortfolioId === p.id;

          if (collapsed) {
            return (
              <li key={p.id}>
                <Link
                  href={`/overview?portfolioId=${p.id}`}
                  title={p.name}
                  className={`flex h-9 w-full items-center justify-center rounded-md transition-colors ${
                    isActive
                      ? "bg-foreground/10 text-foreground"
                      : "text-foreground-muted hover:bg-surface-2 hover:text-foreground"
                  }`}
                >
                  <Briefcase className="h-4 w-4" />
                </Link>
              </li>
            );
          }

          return (
            <li key={p.id}>
              <Collapsible
                open={isExpanded}
                onOpenChange={(open) => setOpenId(open ? p.id : null)}
              >
                {/* Portfolio trigger row — never carries an "active" background.
                    Active state is conveyed by the highlighted sub-item only. */}
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    className="group flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm font-medium text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground"
                  >
                    <Briefcase className="h-4 w-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate text-left">{p.name}</span>
                    <ChevronDown
                      className={`h-4 w-4 shrink-0 transition-transform duration-200 ${
                        isExpanded ? "rotate-180" : ""
                      }`}
                    />
                  </button>
                </CollapsibleTrigger>

                <CollapsibleContent>
                  {/* Vertical connector line + sub-items */}
                  <ul className="relative ml-4 mt-0.5 flex flex-col border-l border-hairline py-1 pl-2">
                    {SUB_ITEMS.map((item) => {
                      const href = item.href(p.id);
                      const active = item.isActive(pathname, searchParams, p.id);
                      return (
                        <li key={item.label}>
                          <Link
                            href={href}
                            className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors ${
                              active
                                ? "bg-foreground/10 font-medium text-foreground"
                                : "text-foreground-muted hover:bg-surface-2 hover:text-foreground"
                            }`}
                          >
                            <span className="grid h-4 w-4 shrink-0 place-items-center opacity-70">
                              {item.icon}
                            </span>
                            {item.label}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </CollapsibleContent>
              </Collapsible>
            </li>
          );
        })}
      </ul>

      {/* ── Spacer + Settings ────────────────────────────────────────────── */}
      <div className="mt-auto px-2">
        <div className="my-2 border-t border-hairline" />
        <Link
          href="/settings"
          title={collapsed ? "Settings" : undefined}
          className={`flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm font-medium transition-colors ${
            isSettingsActive
              ? "bg-foreground/10 text-foreground"
              : "text-foreground-muted hover:bg-surface-2 hover:text-foreground"
          } ${collapsed ? "justify-center" : ""}`}
        >
          <Settings className="h-4 w-4 shrink-0" />
          {!collapsed && <span className="truncate">Settings</span>}
        </Link>
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// AppSidebar
// ---------------------------------------------------------------------------

export function AppSidebar({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const router = useRouter();

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    router.push("/login");
  };

  return (
    <div className="flex min-h-screen w-full bg-background text-foreground">
      <aside
        className={`sticky top-0 flex h-screen shrink-0 flex-col border-r border-hairline bg-surface transition-all duration-200 ${
          collapsed ? "w-[60px]" : "w-[220px]"
        }`}
      >
        {/* Logo */}
        <div
          className={`flex h-14 items-center border-b border-hairline ${
            collapsed ? "justify-center px-2" : "px-4"
          }`}
        >
          <Link
            href="/portfolios"
            aria-label="Node home"
            className="flex min-w-0 items-center gap-2.5"
          >
            <NodeLogo className="h-7 w-7 shrink-0" />
            {!collapsed && (
              <span className="truncate text-sm font-semibold tracking-tight">Node</span>
            )}
          </Link>
        </div>

        {/* Nav (needs searchParams — wrapped in Suspense) */}
        <Suspense fallback={<div className="flex-1" />}>
          <SidebarInner collapsed={collapsed} />
        </Suspense>

        {/* Footer */}
        <div
          className={`flex flex-col gap-1 border-t border-hairline p-2 ${
            collapsed ? "items-center" : ""
          }`}
        >
          <ThemeSwitcher compact={collapsed} />
          <button
            type="button"
            onClick={handleSignOut}
            className={`flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm font-medium text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground ${
              collapsed ? "justify-center" : ""
            }`}
            title={collapsed ? "Sign out" : undefined}
          >
            <LogOut className="h-4 w-4 shrink-0" />
            {!collapsed && <span>Sign out</span>}
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="relative min-w-0 flex-1">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="absolute left-3 top-3 z-30 grid h-8 w-8 place-items-center rounded-md border border-transparent text-foreground-muted transition-colors hover:border-hairline hover:bg-surface hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {collapsed ? (
            <PanelLeftOpen className="h-4 w-4" aria-hidden />
          ) : (
            <PanelLeftClose className="h-4 w-4" aria-hidden />
          )}
        </button>
        {children}
      </main>
    </div>
  );
}
