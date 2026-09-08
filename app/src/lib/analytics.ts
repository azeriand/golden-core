// ---------------------------------------------------------------------------
// analytics.ts — tiny GA4 event helper
//
// Reuses the EXISTING Google Analytics integration wired in app/layout.tsx via
// `<GoogleAnalytics />` from `@next/third-parties/google`. It does NOT
// initialize a second GA instance and does NOT add cookies or consent logic.
//
// `sendGAEvent(...args)` (from @next/third-parties) forwards its arguments to
// the shared `dataLayer`, exactly like calling `gtag(...args)`. To emit a GA4
// event we therefore call it as `sendGAEvent('event', name, params)`, mirroring
// `gtag('event', name, params)`.
//
// Guarantees:
//   * Client-only: no-ops during SSR (no `window`).
//   * Non-blocking: never throws. If GA has not loaded yet, @next/third-parties
//     simply warns and drops the event; any other failure is swallowed so an
//     analytics problem can NEVER interrupt an upload.
// ---------------------------------------------------------------------------

import { sendGAEvent } from "@next/third-parties/google";

/** Allowed GA4 event parameter values (non-sensitive scalars only). */
export type EventParamValue = string | number | boolean | null | undefined;

export type EventParams = Record<string, EventParamValue>;

/**
 * Send a GA4 event. Safe to call from anywhere: it only does work in the
 * browser and never throws.
 *
 * @param name   GA4 event name (e.g. "upload_started").
 * @param params Optional, non-sensitive event parameters. Keys whose value is
 *               `undefined` are dropped so GA never receives empty fields.
 */
export function trackEvent(name: string, params?: EventParams): void {
  // Client-only guard: no dataLayer exists on the server.
  if (typeof window === "undefined") return;

  try {
    const cleaned = params ? stripUndefined(params) : undefined;
    if (cleaned) {
      sendGAEvent("event", name, cleaned);
    } else {
      sendGAEvent("event", name);
    }
  } catch {
    // Analytics is best-effort and MUST be completely non-blocking: swallow any
    // error (e.g. GA not yet loaded) so it can never interrupt an upload.
  }
}

/** Return a shallow copy of `params` without keys whose value is `undefined`. */
function stripUndefined(params: EventParams): EventParams {
  const out: EventParams = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
