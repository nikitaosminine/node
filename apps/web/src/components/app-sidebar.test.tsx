import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, within, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppSidebar } from "@/components/app-sidebar";

const { pathnameRef, searchRef } = vi.hoisted(() => ({
  pathnameRef: { current: "/portfolios" },
  searchRef: { current: "" },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameRef.current,
  useSearchParams: () => new URLSearchParams(searchRef.current),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

// next/link needs the app-router context that isn't mounted in jsdom.
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        order: () => Promise.resolve({ data: [{ id: "p1", name: "Core Growth" }], error: null }),
      }),
    }),
    auth: { signOut: vi.fn().mockResolvedValue({ error: null }) },
  },
}));

const STORAGE_KEY = "binturong.sidebar-collapsed";

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
  window.matchMedia = ((query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    return {
      matches: max ? width <= Number(max[1]) : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
}

function renderShell() {
  return render(
    <AppSidebar>
      <div>
        <h1>Overview</h1>
      </div>
    </AppSidebar>,
  );
}

const sidebar = () => screen.getByRole("complementary");
const collapseToggle = () => within(sidebar()).getByRole("button", { name: /sidebar$/i });

describe("AppSidebar shell", () => {
  beforeEach(() => {
    pathnameRef.current = "/portfolios";
    searchRef.current = "";
    window.localStorage.clear();
    setViewportWidth(1920);
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps the collapse toggle inside the sidebar instead of over the page content", async () => {
    renderShell();
    await screen.findByRole("button", { name: "Core Growth" });

    // Regression: the toggle used to be `absolute left-3 top-3` inside <main>, where it
    // covered the top-left of every page (the Overview <h1>, the detail back arrow).
    const toggle = collapseToggle();
    expect(toggle.closest("aside")).not.toBeNull();
    expect(toggle.closest("main")).toBeNull();

    const main = screen.getByRole("main");
    expect(within(main).queryByRole("button", { name: /sidebar$/i })).toBeNull();
    expect(within(main).getByRole("heading", { name: "Overview" })).toBeVisible();
  });

  it("starts collapsed on a laptop and expanded on a large monitor when nothing is stored", async () => {
    setViewportWidth(1280);
    renderShell();
    expect(await screen.findByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
    expect(within(sidebar()).queryByText("Sign out")).toBeNull();

    cleanup();

    setViewportWidth(1920);
    renderShell();
    expect(await screen.findByRole("button", { name: "Collapse sidebar" })).toBeInTheDocument();
    expect(within(sidebar()).getByText("Sign out")).toBeVisible();
  });

  it("remembers a manual collapse across remounts, overriding the width default", async () => {
    const user = userEvent.setup();
    renderShell();

    await user.click(await screen.findByRole("button", { name: "Collapse sidebar" }));
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("true");
    expect(within(sidebar()).queryByText("Sign out")).toBeNull();

    cleanup();

    // Same 1920 viewport, which would otherwise default to expanded.
    renderShell();
    expect(await screen.findByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("false");

    cleanup();

    setViewportWidth(1280);
    renderShell();
    expect(await screen.findByRole("button", { name: "Collapse sidebar" })).toBeInTheDocument();
  });

  it("opens a labelled navigation drawer from the top bar and closes it on navigation", async () => {
    const user = userEvent.setup();
    setViewportWidth(390);
    const view = renderShell();

    await user.click(screen.getByRole("button", { name: "Open navigation" }));

    const drawer = await screen.findByRole("dialog");
    expect(drawer).toHaveAccessibleName("Navigation");
    expect(within(drawer).getByRole("link", { name: "Expenses" })).toBeVisible();
    expect(within(drawer).getByRole("link", { name: "Settings" })).toBeVisible();
    expect(within(drawer).getByRole("button", { name: "Sign out" })).toBeVisible();

    // Navigating to another route must not leave the drawer over the new page.
    pathnameRef.current = "/expenses";
    view.rerender(
      <AppSidebar>
        <div>
          <h1>Expenses</h1>
        </div>
      </AppSidebar>,
    );

    expect(await screen.findByRole("heading", { name: "Expenses" })).toBeVisible();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
