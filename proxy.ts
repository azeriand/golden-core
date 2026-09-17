import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Edge-level auth gate (defense in depth). This is a CHEAP first barrier: it
// only checks that the `auth_token` cookie is PRESENT and short-circuits with a
// 401 when it is not. It deliberately does NOT verify the JWT signature here —
// full verification (signature, expiry, payload) still happens per-route in the
// Node runtime via lib/auth.ts (verifyRequest) and the inline jwt.verify calls.
// The goal is to stop obviously-unauthenticated requests before they reach the
// route handlers, not to replace route-level authorization.
//
// Next 16 renamed the `middleware` file convention to `proxy` (the function
// MUST be named `proxy` or be the default export). Verified against the bundled
// docs at node_modules/next/dist/docs/.../file-conventions/proxy.md.
//
// Only requests matched by `config.matcher` below run through here, so public
// endpoints (login, signup, demo auth, logout) are never gated.
export function proxy(request: NextRequest) {
    const token = request.cookies.get("auth_token")?.value;

    if (!token) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    return NextResponse.next();
}

export const config = {
    // Only /api/event/* is gated. Verified against the codebase: EVERY handler
    // under /api/event (GET event, GET media download, media POST/PATCH/DELETE,
    // sections, likes, upload-token, confirm, bulk) already requires the
    // auth_token cookie per-route and returns 401 without it — so there is NO
    // public endpoint here that the cookie check would break.
    //
    // Intentionally NOT matched (must stay reachable without a cookie):
    //   - /api/me/login, /api/me/logout   (auth handshake)
    //   - POST /api/me                     (signup — mints the first cookie)
    //   - /api/demo/auth                   (demo auto-login)
    // /api/me is excluded because signup (POST) needs no cookie; its GET/PUT
    // already verify auth per-route.
    matcher: [
        "/api/event/:path*",
    ],
};
