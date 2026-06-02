import { type NextRequest, NextResponse } from "next/server";

// Routes that require a session
const PROTECTED = ["/portfolios", "/the-take", "/settings", "/overview"];

function hasSession(request: NextRequest): boolean {
  // Supabase stores the session as sb-<project-ref>-auth-token
  return request.cookies
    .getAll()
    .some((c) => c.name.startsWith("sb-") && c.name.includes("auth-token"));
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isProtected = PROTECTED.some((p) => pathname === p || pathname.startsWith(p + "/"));
  const isAuthPage = pathname === "/login";
  const isRoot = pathname === "/";
  const authed = hasSession(request);

  if (!authed && (isProtected || isRoot)) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  if (authed && (isAuthPage || isRoot)) {
    return NextResponse.redirect(new URL("/portfolios", request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|brand|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
