# Design Document

## Overview

The Upload_Status_Bar is a client-only React component that renders a pill-shaped
progress indicator over the existing Filter_Pill at the bottom of the event page.
It is a **pure view** over the existing Upload_Store (Zustand): it reads `items`
and derives everything it shows (aggregate progress, done-count, phase) with no
duplicated upload state of its own. The only local state it owns is UI-transient:
the completion phase latch and its 5-second auto-hide timer.

This design also fixes a defect where the Upload_Button (`TbPhotoPlus`) does not
render correctly on desktop.

Scope boundaries:

- **No change to upload orchestration.** The store already exposes everything the
  bar needs (`items`, each with `status` and `progress`, and `activeCount`). The
  bar never calls `enqueueFiles`, `retryItem`, etc.
- **No change to the per-item placeholder UI** (`media-item-placeholder.tsx`) or
  the `UploadPlaceholders` host — those remain the per-tile progress surface. The
  Upload_Status_Bar is a separate, aggregate summary.
- **Client component only.** Per the Next.js 16 server/client model, a component
  that reads a store, uses `useEffect`/`setTimeout`, and renders interactive-ish
  UI must be a Client Component. It lives inside `navbar.tsx`, which is already
  `"use client"`, so it sits entirely within the existing client boundary. No
  server APIs, data fetching, or route handlers are involved, so none of the
  Next.js 16 server-side breaking changes apply here.

## Architecture

```
app/[event-slug]/page.tsx  (client)
  └─ <Navbar/>  (app/components/navbar.tsx, "use client")
       ├─ Filter_Pill  (Card: "Todas" / "Mis fotos")   z-[100], fixed bottom-4
       ├─ Upload_Button (TbPhotoPlus)  {!isDemo}         ← DEFECT FIX (Req 6)
       └─ <UploadStatusBar/>  (NEW)                      z-[101], fixed bottom
             reads useUploadStore  ──────────────────────────────────┐
                                                                      │
app/src/stores/upload.store.ts  (Zustand, single source of truth) ◄──┘
   items: UploadItem[]  (status, progress, ...)
   activeCount: number
```

Data flow (one-directional, read-only):

```
Upload_Store.items ──selectors──► derived view model ──► render
   status per item  ─────────────► phase (active | completion | hidden)
   progress per item ────────────► Aggregate_Progress (mean) ──► ring geometry + "%"
   status === success count ─────► done-count ──► "X de Y"
```

The bar keeps a tiny amount of **presentation-only** state to satisfy the
completion lifecycle (Req 4), because completion is a *latched, time-bounded*
display that cannot be derived from the store snapshot alone:

- `phase`: `"hidden" | "active" | "completion"` — a latch.
- A `setTimeout` handle for the 5s auto-hide.
- A `hasBeenActive` flag (Req 4.1 requires "after at least one upload was in
  progress"), so the bar never shows completion on first mount with an empty store.

This is not a duplicate of upload progress (Req 5.2): it is orthogonal UI phase
state derived from *transitions* in `activeCount`, not a mirrored copy of any
`progress`/counts value.

## Component Placement

The bar renders inside the "Barra normal" branch of `navbar.tsx`, as a sibling of
the Filter_Pill `Card` and the Upload_Button, so it participates in the same fixed
bottom layout family:

- The existing Filter_Pill row is `fixed bottom-4 left-0 right-0 w-full z-[100]`.
- There is a fixed blur-gradient overlay at `z-[99]`.
- The Upload_Status_Bar renders **over** the Filter_Pill at `z-[101]`, anchored to
  the same bottom region so it visually covers the pill while uploads are active
  (Req 1.4). When hidden, the Filter_Pill is fully visible and interactive as
  today; when the bar is shown it sits on top of the pill row.

Because the bar returns `null` while `phase === "hidden"`, it adds nothing to the
layout when idle and never blocks the Filter_Pill outside of an upload run.

### Responsive width (Req 1.5, 1.6)

- **Mobile (< `md:`):** the outer wrapper is `fixed bottom-4 left-0 right-0` with
  the pill spanning full width (`w-full` on the inner content, edge padding via
  `px-4`). Full-width per Req 1.5.
- **Desktop (≥ `md:`):** the wrapper centers its content and the pill sizes to its
  content (`md:w-auto md:left-1/2 md:-translate-x-1/2` with `w-fit` on the pill),
  so it is only as wide as the ring + two text rows require (Req 1.6).

Tailwind v4 is in use (`tailwindcss@^4`), so responsive prefixes (`md:`) and
utility classes behave as normal.

## Components and Interfaces

### `UploadStatusBar` (new) — `app/components/upload-status-bar.tsx`

Client component. No props. Reads the store via scoped selectors and renders the
pill (or `null`).

```tsx
"use client";

// Public: rendered inside navbar's "Barra normal" branch.
export default function UploadStatusBar(): React.ReactElement | null;
```

Internal structure:

```tsx
// 1. Scoped store subscriptions (Req 5.1) — see "Zustand Selector Strategy".
const activeCount = useUploadStore(selectActiveUploadCount); // number
const aggregate   = useUploadStore(selectAggregateProgress); // { done, total, percent }

// 2. Presentation-only phase latch + auto-hide timer (Req 4).
const [phase, setPhase] = useState<Phase>("hidden");
// effect derives phase from activeCount transitions and manages the 5s timer.

// 3. Render null when hidden; otherwise the pill with ring + two text rows,
//    or the completion state (checkmark + done message).
```

### Pure derivation helpers (unit-testable, exported)

These live alongside the component (or in a small `upload-status.ts`) and are
where the correctness properties are validated. They take plain data, not the
store, so they are trivially property-testable.

```ts
// Req 2.2 / 2.4
export function aggregateProgress(progresses: number[]): number;
// mean of progresses, clamped to [0,100], rounded to a whole number; 0 for [].

// Req 3.2
export function doneCount(items: { status: UploadStatus }[]): number;
// count of items whose status === "success".

// Active_Upload definition (Req glossary; Req 1.1/4.4)
export function activeUploadCount(items: { status: UploadStatus }[]): number;
// count of items whose status ∈ { "queued", "processing", "uploading" }.

// Req 2.3 — ring geometry
export function ringDashOffset(percent: number, circumference: number): number;
// circumference * (1 - clamp(percent,0,100)/100).
```

### Selectors (Req 5.1, 5.2)

```ts
// Subscribes to a single primitive (number). Re-renders only when the count of
// active uploads changes — NOT on every progress tick.
const selectActiveUploadCount = (s: UploadStore) => activeUploadCount(s.items);

// Returns a small derived object; paired with a shallow/custom equality so a
// progress tick that does not change the rounded percent / done / total does not
// force a re-render. Uses useShallow at the call site.
const selectAggregateProgress = (s: UploadStore) => ({
  done:    doneCount(s.items),
  total:   currentBatchSize(s.items),   // see "Current batch" below
  percent: aggregateProgress(s.items.map(i => i.progress)),
});
```

Rationale: the existing codebase (`masonry.tsx`, `media-item-placeholder.tsx`)
already establishes the pattern — subscribe to the *narrowest derived value*
using `useShallow` / per-field selectors so progress ticks on one item don't
re-render unrelated components. The status bar follows the same contract.

### Modified: `app/components/navbar.tsx`

1. Render `<UploadStatusBar/>` inside the "Barra normal" branch, layered over the
   Filter_Pill at `z-[101]`.
2. Fix the Upload_Button desktop rendering (see "Desktop Upload Button Fix").

## Data Models

### Phase (presentation-only)

```ts
type Phase = "hidden" | "active" | "completion";
```

Phase transition function (the heart of Req 1 + Req 4), driven purely by
`activeCount` and whether the bar has ever been active in the current run:

```
state: { phase, hasBeenActive, hideTimer }

on activeCount change (a):
  if a > 0:
     clear hideTimer (if any)          // Req 4.6 re-entry cancels auto-hide
     phase := "active"
     hasBeenActive := true
  else /* a === 0 */:
     if phase == "active" and hasBeenActive:
        phase := "completion"          // Req 4.1 / 4.4 (failed/exhausted don't block)
        hideTimer := setTimeout(5s -> { phase := "hidden"; hasBeenActive := false })  // Req 4.5
     // if already "completion" or "hidden": no change

on unmount: clear hideTimer
```

Notes:
- `activeCount` uses the store's already-maintained value semantics, but the bar
  computes it via `activeUploadCount(items)` from the item statuses so the
  definition of Active_Upload (queued | processing | uploading) is enforced in one
  place and matches the glossary. (The store's `activeCount` tracks in-flight
  slots and can differ from queued+in-flight; the bar's phase must key off *all*
  active statuses including `queued`, so it derives from statuses.)
- Failed/exhausted/canceled/success are **not** active, so a batch that ends with
  some failures still drives `activeCount` to 0 and triggers completion (Req 4.4).
- Re-entry (Req 4.6): a new active upload arriving during `"completion"` clears the
  timer and returns to `"active"`; the invariant "activeCount > 0 ⇒ phase active"
  holds regardless of prior phase.

### Current batch (Req 2.2, 3.2)

"Current batch" = the Upload_Items currently represented in the bar's run. The bar
derives counts and mean over `items` (the store already prunes/keeps items across a
run; `success` items remain in `items` until removed, which is exactly what the
"X de Y" and completion computations need — done-count counts `success`, total
counts the batch). Aggregate progress is the mean over all items' `progress` in the
batch, and `success` items contribute `progress: 100` (the store sets `progress: 100`
on success), so the mean converges to 100 as items complete.

### View model (rendered)

```ts
interface StatusBarView {
  phase: Phase;
  percent: number;   // whole number 0-100 (shown while active)
  done: number;      // success count
  total: number;     // batch size
}
```

## UI / Rendering

### Progress_Ring (Req 2.1, 2.3, 2.4)

An inline SVG ring, matching the pattern already used in
`media-item-placeholder.tsx` and the navbar download button (so it stays visually
consistent and needs no new dependency):

```tsx
const R = 20;                       // radius
const C = 2 * Math.PI * R;          // circumference
const offset = ringDashOffset(percent, C); // C * (1 - percent/100)

<svg width="48" height="48" className="-rotate-90">
  <circle cx="24" cy="24" r={R} fill="none" stroke="#F8D6E4" strokeWidth="4" />
  <circle
    cx="24" cy="24" r={R} fill="none"
    stroke="#E83E8C" strokeWidth="4" strokeLinecap="round"
    strokeDasharray={C} strokeDashoffset={offset}
    className="transition-[stroke-dashoffset] duration-200 ease-out"
  />
</svg>
// While active: a centered <span> shows `${percent}%` inside the ring.
// While completion: the <span>/ring center shows a checkmark instead (Req 4.2).
```

The colors reuse the app palette (`#E83E8C` pink accent, `#F8D6E4` track — same
tokens used by the page Loader), so the ring reads clearly on the light
`#FFFCF8` background. The fill is proportional and updates whenever `percent`
changes because it is a pure function of store-derived state (Req 2.5).

### Two text rows (Req 3.1, 3.2, 3.3, 3.4) — Spanish

To the right of the ring, a vertical stack of two rows:

- **Active phase:**
  - Row 1 (done-count): `` `${done} de ${total}` `` (Req 3.2) — e.g. "3 de 8".
  - Row 2 (warning): "No cierres ni recargues la página" (Req 3.3).
- **Completion phase:**
  - Checkmark replaces the ring percentage (Req 4.2).
  - Row(s) replaced by a Spanish done message, e.g. "¡Subida completada!" (Req 4.3).

All copy is Spanish (Req 3.4), consistent with the rest of the app's UI strings.

### Completion checkmark (Req 4.2)

A small inline SVG check (stroke `#E83E8C`) rendered centered where the percentage
was, so the ring keeps its shape (shown full) while the numeric label is swapped
for the check.

## Desktop Upload Button Fix (Req 6)

### Current code (suspect)

```tsx
<Button appearance='mate' color="pink" intensity={700} size='md'
  className="!rounded-full bg-pink-500/90! backdrop-blur-md! border-pink-500! text-white!
             md:text-[#E83E8C]! md:border-pink-500! md:bg-pink-200!"
  style={{ width:'48px', height:'48px', padding:0, display:'flex',
           alignItems:'center', justifyContent:'center' }}
  icon={<TbPhotoPlus size={24}/>}
  onClick={() => fileInputRef.current?.click()} />
```

### Root-cause confirmation (runtime, before editing)

The requirement (6.2) is about the button rendering "correctly" on desktop. Two
plausible causes must be confirmed at runtime (`yarn dev`, desktop viewport ≥ `md:`,
DevTools) rather than assumed:

1. **Low contrast at `md:`** — at desktop the classes resolve to a `md:bg-pink-200!`
   background with `md:text-[#E83E8C]!` icon and a `md:border-pink-500!` border on a
   light `#FFFCF8` page. Pink-200 fill with a mid-pink icon can wash out; if the
   icon/background contrast is insufficient the button "doesn't render correctly"
   (appears blank/near-invisible).
2. **Stacking/overlay interference** — the fixed blur-gradient at `z-[99]` and the
   fixed bar row at `z-[100]`. If the button ends up beneath an overlay or the new
   status bar at desktop, it can appear missing though present in the DOM.

Verification steps recorded in the design (to be executed during implementation):
- Inspect the button element at ≥ `md:`: confirm it is in the DOM, its computed
  background/icon colors, and its stacking context vs. the `z-[99]` gradient and
  `z-[100]` row.
- Check whether the `icon` prop of the library `Button` renders at desktop or
  whether the `!`/`md:*!` important classes collide with the library's own
  `appearance='mate'` styles (the mobile branch uses `bg-pink-500/90!` + `text-white!`
  and renders fine; the `md:` overrides are the delta).

### Fix approach

Adjust the `md:` styling so the icon has clear contrast against its background and
ensure the button shares the correct stacking context with the rest of the bottom
bar (it already lives in the `z-[100]` row; the new status bar at `z-[101]` must not
cover it — the status bar overlays the Filter_Pill, not the trailing Upload_Button,
and only while active).

- Give the desktop state a legible pairing: a solid enough background with an icon
  color that meets contrast (e.g. keep the pink accent icon on a lighter fill only
  if contrast is adequate; otherwise use the same white-icon-on-pink treatment that
  already works on mobile, or a `md:bg-pink-500!` + `md:text-white!` pairing). The
  exact final values are chosen after the runtime contrast check so we address the
  confirmed cause, not a guess.
- Preserve mobile appearance/behavior unchanged (Req 6.4): only `md:` classes are
  touched.
- Preserve conditional rendering: still inside `{!isDemo && (...)}` so it shows for
  non-demo at desktop (Req 6.1) and the `onClick` still triggers
  `fileInputRef.current?.click()` (Req 6.3).

This keeps the change minimal and evidence-driven.

## Error Handling

The bar is a read-only view with a single timer; failure surfaces are limited:

- **Empty batch / no items:** `aggregateProgress([])` returns `0` (no division by
  zero), `doneCount`/`total` are `0`, and `activeUploadCount` is `0`, so `phase`
  stays `"hidden"` and the component returns `null`. Safe by construction.
- **All items failed/exhausted:** `activeUploadCount === 0`, so if the run had been
  active the bar enters completion and shows the done message (Req 4.4). The bar
  does not itself surface per-item errors — those remain the placeholders' job.
- **Timer safety:** the auto-hide `setTimeout` is stored in a ref and always cleared
  on re-entry (Req 4.6) and on unmount, so it cannot fire against an unmounted
  component or leak. Re-entry clearing prevents a stale hide from dismissing a fresh
  batch.
- **SSR / hydration:** the component is client-only and reads a client store; it
  renders `null` until there is active upload state, matching the page's existing
  hydration guard, so there is no server/client markup mismatch.

## Testing Strategy

**Dual approach.** Property tests validate the pure derivations and the phase state
machine across many generated inputs (fast-check is already a dev dependency).
Example/unit tests (Vitest + Testing Library, both already present) cover rendering,
Spanish copy, the 5s timer (fake timers), responsive classes, and the upload-button
fix.

Property tests:
- Minimum 100 iterations each (fast-check default is ≥100).
- Each tagged: **Feature: upload-status-bar, Property {n}: {property text}**.
- Reference the design property they validate.

Example/integration tests (representative, not exhaustive):
- Ring + two rows render while active; percentage shown inside ring (Req 2.1, 2.4, 3.1).
- Spanish warning row present while active; done message + checkmark in completion
  (Req 3.3, 4.2, 4.3, 3.4).
- Auto-hide: enter completion, advance fake timer 5s ⇒ hidden; < 5s ⇒ still visible
  (Req 4.5).
- Positioning/responsive: correct fixed + `z` classes over the pill (Req 1.4);
  full-width mobile vs. content-width desktop classes (Req 1.5, 1.6).
- Re-render count: an unrelated subscriber does not re-render on a progress-only
  tick that doesn't change the rounded percent/done/total (Req 5.1).
- Upload button: visible non-demo at `md:`, absent for demo (Req 6.1); click opens
  the file picker (Req 6.3); mobile classes unchanged (Req 6.4). Contrast verified
  at runtime (Req 6.2).

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid
executions of a system — essentially, a formal statement about what the system
should do. Properties serve as the bridge between human-readable specifications and
machine-verifiable correctness guarantees.*

### Property 1: Phase/visibility state machine

For any sequence of Upload_Store snapshots (each a list of Upload_Items with
arbitrary statuses) applied in order, the bar's phase satisfies: whenever the number
of Active_Uploads (items with status `queued`, `processing`, or `uploading`) is
greater than zero, the phase is `active` (and the bar is visible); when it drops to
zero after having been `active`, the phase becomes `completion` (visible) regardless
of how many items ended `failed`, `exhausted`, `canceled`, or `success`; a new
Active_Upload appearing during `completion` returns the phase to `active` and cancels
any pending auto-hide; and the bar is hidden only when no Active_Upload exists and no
`completion` display is in effect.

**Validates: Requirements 1.1, 1.2, 1.3, 4.1, 4.4, 4.6**

### Property 2: Aggregate progress is the whole-number mean, bounded

For any list of Upload_Item `progress` values in the range 0–100, the computed
Aggregate_Progress equals the arithmetic mean of those values rounded to a whole
number, always lies within 0–100 inclusive, equals that common value when all inputs
are equal, and equals 0 for an empty batch.

**Validates: Requirements 2.2, 2.4**

### Property 3: Ring fill is proportional and monotonic

For any Aggregate_Progress percentage in 0–100 and any positive ring circumference,
the ring stroke-dash offset lies within 0 to the circumference inclusive, decreases
monotonically as the percentage increases, equals the full circumference at 0% (empty
ring), and equals 0 at 100% (full ring) — so the visible fill is exactly proportional
to the percentage.

**Validates: Requirements 2.3**

### Property 4: Done-count text reflects success count out of batch total

For any current batch of Upload_Items, the first text row's done-count equals the
number of items whose status is `success`, the total equals the number of items in
the batch, the done-count never exceeds the total, and the rendered string is exactly
`"{done} de {total}"`.

**Validates: Requirements 3.2**
