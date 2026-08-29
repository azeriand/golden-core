// Client-only PWA helpers: service-worker registration (prod only), a
// cache-purge signal used when the auth session is invalidated, and last-known
// auth-user persistence so a previously-authenticated user can open the app
// OFFLINE without being forced to the login screen.
//
// SECURITY NOTE: the cached user is a UX hint only, NOT an auth boundary. It
// holds only non-sensitive profile fields (never the httpOnly token). Every
// mutating request is still authorized server-side by the cookie, and a real
// 401/403 clears this immediately (see clearCachedAuthUser).

export const AUTH_CACHE_KEY = "gc-auth-user";

/** Read the last-known user (or null) from localStorage. Best-effort. */
export function readCachedAuthUser<T = unknown>(): T | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(AUTH_CACHE_KEY);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/** Persist the last-known user (best-effort; ignores quota/private-mode). */
export function writeCachedAuthUser(user: unknown | null): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (user) localStorage.setItem(AUTH_CACHE_KEY, JSON.stringify(user));
    else localStorage.removeItem(AUTH_CACHE_KEY);
  } catch {
    /* ignore */
  }
}

/** Clear the cached user (on logout / invalid session). */
export function clearCachedAuthUser(): void {
  writeCachedAuthUser(null);
}

/**
 * Register the service worker. PRODUCTION-ONLY: service workers cache
 * aggressively, which is undesirable during development, and the SW is only
 * shipped/served in a production build. Safe to call unconditionally — it
 * no-ops when SW is unsupported or not in production.
 */
export function registerServiceWorker(): void {
  if (typeof window === "undefined") return;
  if (process.env.NODE_ENV !== "production") return;
  if (!("serviceWorker" in navigator)) return;

  // Register after load so it never competes with first paint / hydration.
  const register = () => {
    navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .catch(() => {
        /* best-effort: a failed SW registration must not break the app */
      });
  };

  if (document.readyState === "complete") {
    register();
  } else {
    window.addEventListener("load", register, { once: true });
  }
}

/**
 * Ask the active service worker to purge the private caches (event data +
 * media). Called when the auth session is invalidated (logout / 401 / 403) so a
 * logged-out or invalid session can never be shown cached private media.
 * Best-effort and safe to call when SW is unavailable.
 */
export function purgeServiceWorkerCaches(): void {
  if (typeof navigator === "undefined") return;
  if (!("serviceWorker" in navigator)) return;
  try {
    navigator.serviceWorker.controller?.postMessage({ type: "PURGE_CACHES" });
    // Also cover the brief window where there is no controller yet (e.g. first
    // load) by messaging the ready registration's active worker.
    navigator.serviceWorker.ready
      .then((reg) => reg.active?.postMessage({ type: "PURGE_CACHES" }))
      .catch(() => {});
  } catch {
    /* ignore */
  }
}
