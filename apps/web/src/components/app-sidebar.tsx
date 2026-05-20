"use client";

import { useState, type ReactNode, Suspense } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { BarChart3, LayoutDashboard, LogOut, PanelLeftClose, PanelLeftOpen, Settings, TrendingUp } from "lucide-react";
import { NodeLogo } from "@/components/node-logo";
import { ThemeSwitcher } from "@/components/ThemeSwitcher";
import { supabase } from "@/integrations/supabase/client";
import { PortfolioPicker } from "@/components/portfolio-picker";

// ---------------------------------------------------------------------------
// Nav items (flat IA — Overview / Details / The Take / Settings)
// ---------------------------------------------------------------------------

const NAV_ITEMS = [
  { to: "/overview", label: "Overview", icon: <LayoutDashboard className="h-4 w-4" /> },
  { to: "/details", label: "Details", icon: <BarChart3 className="h-4 w-4" /> },
  { to: "/the-take", label: "The Take", icon: <TrendingUp className="h-4 w-4" /> },
] as const;

const SETTINGS_ITEM = {
  to: "/settings",
  label: "Settings",
  icon: <Settings className="h-4 w-4" />,
} as const;

// ---------------------------------------------------------------------------
// Inner sidebar that needs search params (wrapped in Suspense)
// ---------------------------------------------------------------------------

function SidebarInner({ collapsed }: { collapsed: boolean }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const portfolioId = searchParams.get("portfolioId") ?? "";

  function buildHref(to: string) {
    if (!portfolioId) return to;
    return `${to}?portfolioId=${portfolioId}`;
  }

  function isActive(to: string) {
    // /details maps to /portfolios/[portfolioId]
    if (to === "/details") {
      return pathname.startsWith("/portfolios/") && pathname.includes("/");
    }
    return pathname.startsWith(to);
  }

  return (
    <>
      {/* Portfolio picker */}
      {!collapsed && (
        <div className="border-b border-hairline">
          <Suspense fallback={null}>
            <PortfolioPicker collapsed={false} />
          </Suspense>
        </div>
      )}
      {collapsed && (
        <div className="border-b border-hairline py-1">
          <Suspense fallback={null}>
            <PortfolioPicker collapsed={true} />
          </Suspense>
        </div>
      )}

      {/* Main nav */}
      <nav className="flex-1 overflow-y-auto px-2 py-3">
        <ul className="flex flex-col gap-0.5">
          {NAV_ITEMS.map((item) => {
            const active = isActive(item.to);
            const href =
              item.to === "/details"
                ? portfolioId
                  ? `/portfolios/${portfolioId}`
                  : "/portfolios"
                : buildHref(item.to);
            return (
              <li key={item.to}>
                <Link
                  href={href}
                  title={collapsed ? item.label : undefined}
                  className={`flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
                    active
                      ? "bg-foreground/10 text-foreground"
                      : "text-foreground-muted hover:bg-surface-2 hover:text-foreground"
                  } ${collapsed ? "justify-center" : ""}`}
                >
                  <span className="grid h-5 w-5 shrink-0 place-items-center">{item.icon}</span>
                  {!collapsed && <span className="truncate">{item.label}</span>}
                </Link>
              </li>
            );
          })}
        </ul>

        {/* Settings divider */}
        <div className="mx-2 my-3 border-t border-hairline" />
        <ul>
          <li>
            <Link
              href={SETTINGS_ITEM.to}
              title={collapsed ? SETTINGS_ITEM.label : undefined}
              className={`flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
                pathname.startsWith(SETTINGS_ITEM.to)
                  ? "bg-foreground/10 text-foreground"
                  : "text-foreground-muted hover:bg-surface-2 hover:text-foreground"
              } ${collapsed ? "justify-center" : ""}`}
            >
              <span className="grid h-5 w-5 shrink-0 place-items-center">{SETTINGS_ITEM.icon}</span>
              {!collapsed && <span className="truncate">{SETTINGS_ITEM.label}</span>}
            </Link>
          </li>
        </ul>
      </nav>
    </>
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
          collapsed ? "w-[68px]" : "w-[232px]"
        }`}
      >
        {/* Logo */}
        <div
          className={`relative flex h-14 items-center border-b border-hairline ${
            collapsed ? "justify-center px-2" : "justify-start px-3"
          }`}
        >
          <Link
            href="/overview"
            aria-label="Node home"
            className={`flex min-w-0 items-center ${
              collapsed
                ? "absolute left-1/2 h-10 w-10 -translate-x-1/2 justify-center overflow-hidden"
                : "gap-2 overflow-hidden"
            }`}
          >
            <NodeLogo className={collapsed ? "h-9 w-9" : "h-8 w-8"} />
            {!collapsed && (
              <span className="truncate text-base font-semibold tracking-tight">Node</span>
            )}
          </Link>
        </div>

        {/* Portfolio picker + nav (needs searchParams — wrapped in Suspense) */}
        <Suspense fallback={<div className="flex-1" />}>
          <SidebarInner collapsed={collapsed} />
        </Suspense>

        {/* Footer */}
        <div
          className={`flex flex-col gap-1 border-t border-hairline p-2 ${collapsed ? "items-center" : ""}`}
        >
          <ThemeSwitcher compact={collapsed} />
          <button
            type="button"
            onClick={handleSignOut}
            className={`flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm font-medium text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground ${
              collapsed ? "justify-center" : ""
            }`}
            title={collapsed ? "Sign out" : undefined}
          >
            <LogOut className="h-4 w-4 shrink-0" />
            {!collapsed && <span>Sign out</span>}
          </button>
        </div>
      </aside>

      {/* Main */}
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
