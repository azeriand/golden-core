import type { UploadStatus, UploadStore } from "@/app/src/stores/upload.store";

// ---------------------------------------------------------------------------
// upload-status.ts — pure derivation helpers for the Upload_Status_Bar.
//
// These helpers take plain data (never the store) so they are trivially
// unit/property testable. They are the single place the correctness properties
// (aggregate progress, ring geometry, done-count, active-count) are enforced.
// ---------------------------------------------------------------------------

/** Statuses that count as an Active_Upload (work pending or in flight). */
const ACTIVE_STATUSES: ReadonlySet<UploadStatus> = new Set<UploadStatus>([
  "queued",
  "processing",
  "uploading",
]);

/** Clamp a value into the inclusive [min, max] range. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Aggregate_Progress (Req 2.2 / 2.4): the arithmetic mean of the given progress
 * values, clamped to [0, 100] and rounded to a whole number. Returns 0 for an
 * empty batch (no division by zero).
 */
export function aggregateProgress(progresses: number[]): number {
  if (progresses.length === 0) return 0;
  const sum = progresses.reduce((total, value) => total + value, 0);
  const mean = sum / progresses.length;
  return Math.round(clamp(mean, 0, 100));
}

/**
 * Done-count (Req 3.2): the number of items whose status is `success`.
 */
export function doneCount(items: { status: UploadStatus }[]): number {
  return items.filter((item) => item.status === "success").length;
}

/**
 * Active_Upload count (Req 1.1 / 4.4): the number of items whose status is one
 * of `queued`, `processing`, or `uploading`.
 */
export function activeUploadCount(items: { status: UploadStatus }[]): number {
  return items.filter((item) => ACTIVE_STATUSES.has(item.status)).length;
}

/**
 * Ring geometry (Req 2.3): the SVG stroke-dash offset for a given percentage and
 * circumference. `circumference * (1 - clamp(percent, 0, 100) / 100)` — full
 * circumference at 0% (empty ring), 0 at 100% (full ring).
 */
export function ringDashOffset(percent: number, circumference: number): number {
  return circumference * (1 - clamp(percent, 0, 100) / 100);
}

// ---------------------------------------------------------------------------
// Scoped store selectors (Req 5.1, 5.2)
//
// These read the Upload_Store and derive the narrowest values the
// Upload_Status_Bar renders, so unrelated components do not re-render on
// progress ticks. They follow the per-field / narrow-selector subscription
// pattern established by media-item-placeholder.tsx (which selects only its own
// item, relying on the store's immutable `items.map` to keep unchanged
// references stable).
//
// The Upload_Store is the single source of truth (Req 5.2): everything here is
// derived from `s.items` with no duplicated upload state.
// ---------------------------------------------------------------------------

/**
 * Selects the Active_Upload count as a PRIMITIVE number (Req 5.1). Because the
 * result is a primitive, Zustand's default `Object.is` equality re-renders the
 * subscriber only when the count of active uploads actually changes — never on a
 * progress-only tick that leaves the active count unchanged.
 */
export const selectActiveUploadCount = (s: UploadStore): number =>
  activeUploadCount(s.items);

/**
 * Selects the small aggregate view model the status bar renders: the success
 * done-count, the batch total (`s.items.length`), and the whole-number aggregate
 * progress percent (Req 2.2 / 3.2 / 5.2).
 *
 * This returns a NEW object each call, so it MUST be consumed at the call site
 * with `useShallow` (from `zustand/react/shallow`) — a shallow field-by-field
 * comparison — so a progress tick that does not change the rounded `percent`,
 * `done`, or `total` does NOT force a re-render. The `useShallow` wiring lives in
 * the component task (3.1); this selector only defines the derivation.
 */
export const selectAggregateProgress = (
  s: UploadStore
): { done: number; total: number; percent: number } => ({
  done: doneCount(s.items),
  total: s.items.length,
  percent: aggregateProgress(s.items.map((i) => i.progress)),
});
