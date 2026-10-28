import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Next 16 renamed the `middleware` file convention to `proxy` (the function
// MUST be named `proxy` or be the default export). Verified against the bundled
// docs at node_modules/next/dist/docs/.../file-conventions/proxy.md.
//
// This file now does TWO things, gated by `config.matcher` below:
//
//   A) Edge-level auth gate for /api/event/* (pre-existing behavior, unchanged).
//   B) Site-closure kill-switch for the public pages + user creation, active
//      only when MAINTENANCE_MODE === "true".
//
// With MAINTENANCE_MODE unset/false the closure is completely inert and the app
// keeps its exact normal behavior. To reopen the site, unset the flag. No
// routes, components, users, events or photos are removed — fully reversible.

// ----------------------------------------------------------------------------
// (B) Site-closure configuration
// ----------------------------------------------------------------------------

// The only event that stays reachable while the site is closed. Compared with
// an EXACT, case-sensitive equality so no other event can slip through.
const ALLOWED_EVENT_SLUG = "sara-y-lucia-2026-10-03";

// Controlled pages served while closed (static routes under app/maintenance).
const MAINTENANCE_PAGE = "/maintenance";
// Download screen for the allowed event (explains + offers a SwissTransfer button).
const DOWNLOAD_PAGE = "/maintenance/downloads";

function isMaintenanceMode(): boolean {
  return process.env.MAINTENANCE_MODE === "true";
}

// Handles the public (non-/api) side of the closure. Returns a response to send
// or `null` to let the request continue normally.
function handleClosurePublic(request: NextRequest): NextResponse | null {
  const { pathname } = request.nextUrl;

  // Keep the DEMO fully intact (reuses the existing "/demo" slug convention).
  if (pathname === "/demo") {
    return null;
  }

  // Never intercept our own controlled pages (avoids a redirect loop).
  if (pathname === MAINTENANCE_PAGE || pathname === DOWNLOAD_PAGE) {
    return null;
  }

  // The matcher restricts this to top-level event paths, so `pathname` is
  // "/<event-slug>". Strip the leading slash and compare EXACTLY.
  const slug = pathname.slice(1);

  // The single allowed event -> the download screen. We do NOT auto-redirect to
  // SwissTransfer; instead we send the user to a controlled page that explains
  // the download and offers a button to open the SwissTransfer link. That page
  // reads SWISSTRANSFER_URL server-side (and shows a fallback message if it is
  // not configured), so the proxy never needs the link itself.
  if (slug === ALLOWED_EVENT_SLUG) {
    return NextResponse.redirect(new URL(DOWNLOAD_PAGE, request.url));
  }

  // Any other event page -> static "site closed" page.
  //
  // We REDIRECT (not rewrite) on purpose. The root layout is a Client Component
  // that decides whether to show the AuthPopup from `usePathname()`. After a
  // rewrite the browser URL stays on the event slug while only the rendered
  // content is `/maintenance`, so `usePathname()` still reports the event path
  // and the popup leaks on top of the closed page (and risks a hydration
  // mismatch — see Next's usePathname + rewrites note). A redirect changes the
  // browser URL to `/maintenance`, so the layout's existing maintenance-route
  // check reliably suppresses the popup.
  return NextResponse.redirect(new URL(MAINTENANCE_PAGE, request.url));
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // ------------------------------------------------------------------
  // API paths
  // ------------------------------------------------------------------
  if (pathname.startsWith("/api")) {
    // (B) While closed, block BOTH account creation (POST /api/me) AND user
    //     login (POST /api/me/login). The demo authenticates via /api/demo/*,
    //     which is never matched/touched, so the demo keeps working.
    if (
      isMaintenanceMode() &&
      request.method === "POST" &&
      (pathname === "/api/me" || pathname === "/api/me/login")
    ) {
      return NextResponse.json(
        { error: "El acceso está deshabilitado temporalmente" },
        { status: 503 }
      );
    }

    // (A) Pre-existing edge-level auth gate for /api/event/*: a CHEAP first
    //     barrier that only checks the `auth_token` cookie is PRESENT (full JWT
    //     verification still happens per-route via lib/auth.ts). Public
    //     endpoints (login, logout, signup, demo auth) are never matched.
    if (pathname.startsWith("/api/event")) {
      const token = request.cookies.get("auth_token")?.value;
      if (!token) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    return NextResponse.next();
  }

  // ------------------------------------------------------------------
  // Public pages
  // ------------------------------------------------------------------
  if (isMaintenanceMode()) {
    const closure = handleClosurePublic(request);
    if (closure) return closure;
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // (A) Auth-gated API: every /api/event handler already requires the
    //     auth_token cookie per-route, so the cookie presence check is safe.
    "/api/event/:path*",
    // (B) The account-creation and login endpoints the closure blocks (POST
    //     only; checked inside the proxy). Matched always so the 503 applies in
    //     production. The demo login (/api/demo/*) is intentionally NOT matched.
    "/api/me",
    "/api/me/login",
    // (B) Top-level public pages (event slugs, "/demo"), excluding Next
    //     internals and static/metadata files. A single segment with no "/"
    //     avoids matching nested asset paths. Only acted on when the flag is on.
    "/((?!api|_next/static|_next/image|favicon.ico|manifest.webmanifest|sw.js|icon|apple-icon|robots.txt|sitemap.xml|.*\\..*).*)",
  ],
};
