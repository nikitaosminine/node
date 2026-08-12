"use client";

import {
  useState,
  useEffect,
  useCallback,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  Suspense,
} from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Briefcase,
  ChevronDown,
  LayoutDashboard,
  BarChart3,
  Menu,
  TrendingUp,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Wallet,
} from "lucide-react";
import { NodeLogo } from "@/components/node-logo";
import { ThemeSwitcher } from "@/components/ThemeSwitcher";
import { supabase } from "@/integrations/supabase/client";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Collapse preference
// ---------------------------------------------------------------------------

/** Matches the `binturong.` key convention already used for `last-portfolio-id`. */
const COLLAPSED_STORAGE_KEY = "binturong.sidebar-collapsed";

/**
 * Width at or above which a first-time visitor gets the expanded sidebar.
 * Below it (laptops) we start collapsed to hand ~160px back to the content column.
 */
const EXPANDED_MIN_WIDTH = 1536;

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

function SidebarInner({ collapsed, portfolios }: { collapsed: boolean; portfolios: Portfolio[] }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activePortfolioId = useActivePortfolioId();

  const [openId, setOpenId] = useState<string | null>(activePortfolioId);

  // Auto-expand when navigation changes active portfolio
  useEffect(() => {
    if (activePortfolioId) setOpenId(activePortfolioId);
  }, [activePortfolioId]);

  const isSettingsActive = pathname.startsWith("/settings");
  const isExpensesActive = pathname.startsWith("/expenses");

  return (
    <nav className="flex flex-1 flex-col overflow-y-auto py-3">
      {/* ── PORTFOLIOS section ───────────────────────────────────────────── */}
      {!collapsed && (
        <div className="mb-1 px-4">
          <Link
            href="/portfolios"
            className="text-[11.5px] font-semibold uppercase tracking-widest text-foreground-muted hover:text-foreground transition-colors"
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
              <Collapsible open={isExpanded} onOpenChange={(open) => setOpenId(open ? p.id : null)}>
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

      {/* ── Expenses (own top-level section) ─────────────────────────────── */}
      <div className="mt-3 px-2">
        <Link
          href="/expenses"
          title={collapsed ? "Expenses" : undefined}
          className={`flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm font-medium transition-colors ${
            isExpensesActive
              ? "bg-foreground/10 text-foreground"
              : "text-foreground-muted hover:bg-surface-2 hover:text-foreground"
          } ${collapsed ? "justify-center" : ""}`}
        >
          <Wallet className="h-4 w-4 shrink-0" />
          {!collapsed && <span className="truncate">Expenses</span>}
        </Link>
      </div>

      {/* ── Settings (pinned to bottom) ──────────────────────────────────── */}
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

/**
 * Fires whenever the full location changes — pathname *or* query string.
 * `useSearchParams` lives here, in its own Suspense boundary, so AppSidebar
 * itself stays outside it.
 */
function LocationEffect({ onChange }: { onChange: () => void }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const location = `${pathname}?${searchParams.toString()}`;

  useEffect(() => {
    onChange();
  }, [location, onChange]);

  return null;
}

function SignOutButton({ collapsed, onSignOut }: { collapsed: boolean; onSignOut: () => void }) {
  return (
    <button
      type="button"
      onClick={onSignOut}
      className={cn(
        "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm font-medium text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground",
        collapsed && "justify-center",
      )}
      title={collapsed ? "Sign out" : undefined}
    >
      <LogOut className="h-4 w-4 shrink-0" />
      {!collapsed && <span>Sign out</span>}
    </button>
  );
}

export function AppSidebar({ children }: { children: ReactNode }) {
  // SSR renders the expanded sidebar; the stored preference is applied in an
  // effect so the server and first client render agree.
  const [collapsed, setCollapsed] = useState(false);
  const [transitionsEnabled, setTransitionsEnabled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const isMobile = useIsMobile();
  const router = useRouter();

  // Owned here, not in SidebarInner: that renders twice (desktop rail + drawer),
  // and the drawer copy remounts on every open.
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);

  useEffect(() => {
    supabase
      .from("portfolios")
      .select("id,name")
      .order("created_at", { ascending: true })
      .then(({ data }) => {
        if (data) setPortfolios(data as Portfolio[]);
      });
  }, []);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(COLLAPSED_STORAGE_KEY);
    } catch {
      // Storage can be unavailable (private mode / blocked cookies) — fall back to width.
    }
    setCollapsed(stored === null ? window.innerWidth < EXPANDED_MIN_WIDTH : stored === "true");

    // Enable the width transition only after the restored state has been painted,
    // otherwise the restore itself animates as a visible sweep on first load.
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setTransitionsEnabled(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, []);

  // A manual choice always wins over the width default from here on.
  const toggleCollapsed = useCallback(() => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      window.localStorage.setItem(COLLAPSED_STORAGE_KEY, String(next));
    } catch {
      // Non-fatal: the sidebar just won't remember across reloads.
    }
  }, [collapsed]);

  // Tapping a nav item must not leave the drawer open over the new page.
  const closeDrawer = useCallback(() => setMobileOpen(false), []);

  // Taps that resolve to the URL already showing produce no navigation at all,
  // so LocationEffect never fires — close on the link tap itself as well.
  const handleDrawerClick = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("a")) setMobileOpen(false);
  }, []);

  // Resizing up to a desktop width reveals the real sidebar — drop the drawer.
  useEffect(() => {
    if (!isMobile) setMobileOpen(false);
  }, [isMobile]);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    router.push("/login");
  };

  const collapseToggle = (
    <button
      type="button"
      onClick={toggleCollapsed}
      aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      className={cn(
        "grid shrink-0 place-items-center rounded-md border border-transparent text-foreground-muted transition-colors hover:border-hairline hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        collapsed ? "h-6 w-6" : "h-8 w-8",
      )}
    >
      {collapsed ? (
        <PanelLeftOpen className="h-4 w-4" aria-hidden />
      ) : (
        <PanelLeftClose className="h-4 w-4" aria-hidden />
      )}
    </button>
  );

  return (
    <div className="flex min-h-dvh w-full bg-background text-foreground md:min-h-screen">
      <Suspense fallback={null}>
        <LocationEffect onChange={closeDrawer} />
      </Suspense>

      {/* Desktop sidebar — hidden below md by CSS, never by a JS branch. */}
      <aside
        className={cn(
          "sticky top-0 hidden h-screen shrink-0 flex-col border-r border-hairline bg-surface md:flex",
          transitionsEnabled && "transition-all duration-200",
          collapsed ? "w-[60px]" : "w-[220px]",
        )}
      >
        {/* Logo + collapse toggle */}
        <div
          className={cn(
            "flex h-14 items-center border-b border-hairline",
            collapsed ? "justify-center gap-1 px-1" : "gap-2 pl-4 pr-2",
          )}
        >
          <Link
            href="/portfolios"
            aria-label="Node home"
            title={collapsed ? "Node home" : undefined}
            className={cn("flex min-w-0 items-center gap-2.5", !collapsed && "flex-1")}
          >
            <NodeLogo className={cn("shrink-0", collapsed ? "h-6 w-6" : "h-8 w-8")} />
            {!collapsed && (
              <span className="truncate text-[15px] font-semibold tracking-tight">Node</span>
            )}
          </Link>
          {collapseToggle}
        </div>

        {/* Nav (needs searchParams — wrapped in Suspense) */}
        <Suspense fallback={<div className="flex-1" />}>
          <SidebarInner collapsed={collapsed} portfolios={portfolios} />
        </Suspense>

        {/* Footer */}
        <div
          className={cn(
            "flex flex-col gap-1 border-t border-hairline p-2",
            collapsed && "items-center",
          )}
        >
          <ThemeSwitcher compact={collapsed} />
          <SignOutButton collapsed={collapsed} onSignOut={handleSignOut} />
        </div>
      </aside>

      {/* Mobile drawer */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent
          side="left"
          className="flex flex-col gap-0 border-hairline bg-surface p-0"
          onClick={handleDrawerClick}
        >
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <div className="flex h-14 shrink-0 items-center border-b border-hairline px-4">
            <Link
              href="/portfolios"
              aria-label="Node home"
              className="flex min-w-0 items-center gap-2.5"
            >
              <NodeLogo className="h-8 w-8 shrink-0" />
              <span className="truncate text-[15px] font-semibold tracking-tight">Node</span>
            </Link>
          </div>

          <Suspense fallback={<div className="flex-1" />}>
            <SidebarInner collapsed={false} portfolios={portfolios} />
          </Suspense>

          <div className="flex flex-col gap-1 border-t border-hairline p-2">
            <SignOutButton collapsed={false} onSignOut={handleSignOut} />
          </div>
        </SheetContent>
      </Sheet>

      {/* Main content */}
      <main className="relative min-w-0 flex-1">
        {/* Mobile top bar */}
        <header className="sticky top-0 z-20 flex h-14 items-center gap-1 border-b border-hairline bg-surface px-2 md:hidden">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            aria-label="Open navigation"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Menu className="h-5 w-5" aria-hidden />
          </button>
          <Link
            href="/portfolios"
            aria-label="Node home"
            className="flex min-w-0 items-center gap-2"
          >
            <NodeLogo className="h-7 w-7 shrink-0" />
            <span className="truncate text-[15px] font-semibold tracking-tight">Node</span>
          </Link>
          <div className="ml-auto shrink-0">
            <ThemeSwitcher compact />
          </div>
        </header>
        {children}
      </main>
    </div>
  );
}
