import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://sfqowvpuzsqgmwlecgdx.supabase.co";
const SUPABASE_PUBLISHABLE_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  "sb_publishable_xcYBQwzQm7_Cv8eoqAI8rw_eFVLZiGp";

// Routes that require a valid session
const PROTECTED = ["/portfolios", "/the-take", "/settings", "/overview"];

export async function proxy(request: NextRequest) {
  // This response object is what we return; Supabase may write refreshed
  // auth cookies onto it via setAll below.
  let response = NextResponse.next({ request });

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  // getUser() validates the token against Supabase (and refreshes it if the
  // access token expired but the refresh token is still good). This is the
  // real check — not just "does a cookie exist".
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isProtected = PROTECTED.some((p) => pathname === p || pathname.startsWith(p + "/"));
  const isAuthPage = pathname === "/login";
  const isRoot = pathname === "/";

  // No valid session → keep them out of the app
  if (!user && (isProtected || isRoot)) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Valid session → don't let them sit on /login or the bare root
  if (user && (isAuthPage || isRoot)) {
    return NextResponse.redirect(new URL("/portfolios", request.url));
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|brand|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
