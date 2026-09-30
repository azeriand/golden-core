# Implementation Plan: Upload Status Bar

## Overview

Build the Upload_Status_Bar as a client-only React component that is a pure view over the existing Upload_Store (Zustand). Work proceeds bottom-up: first the pure, property-testable derivation helpers, then the scoped store selectors, then the phase state machine with its auto-hide timer, then the rendered pill (Progress_Ring + two Spanish text rows + completion state), then integration into `navbar.tsx`, and finally the evidence-driven desktop Upload_Button fix.

Language: TypeScript / React (Next.js 16, Tailwind v4), matching the existing codebase. Per `AGENTS.md`, this Next.js version has breaking changes — consult the relevant guide under `node_modules/next/dist/docs/` before writing any code that touches Next.js APIs or conventions (the component is client-only inside the already-`"use client"` `navbar.tsx`, so no server-side APIs are involved).

Testing is dual: fast-check property tests (100+ iterations, tagged `Feature: upload-status-bar, Property {n}: {property text}`) for the 4 correctness properties, plus Vitest + Testing Library example/timer/render-count tests. All tooling (`vitest`, `fast-check`, `@testing-library/react`, `jsdom`) is already a dev dependency; run with `yarn test`.

## Tasks

- [x] 1. Create pure derivation helpers
  - [x] 1.1 Implement derivation helpers in `app/components/upload-status.ts`
    - Create the file and export `aggregateProgress(progresses: number[]): number` — arithmetic mean clamped to [0,100], rounded to a whole number, returns `0` for `[]`
    - Export `doneCount(items: { status: UploadStatus }[]): number` — count of items whose `status === "success"`
    - Export `activeUploadCount(items: { status: UploadStatus }[]): number` — count of items whose status is one of `queued`, `processing`, `uploading`
    - Export `ringDashOffset(percent: number, circumference: number): number` — `circumference * (1 - clamp(percent,0,100)/100)`
    - Import the `UploadStatus` type from `@/app/src/stores/upload.store`
    - _Requirements: 2.2, 2.4, 3.2, 2.3, 1.1, 4.4_

  - [x] 1.2 Write property test for aggregate progress
    - **Property 2: Aggregate progress is the whole-number mean, bounded**
    - **Validates: Requirements 2.2, 2.4**
    - fast-check, 100+ runs; tag `Feature: upload-status-bar, Property 2: Aggregate progress is the whole-number mean, bounded`
    - Assert result equals the rounded arithmetic mean, lies in [0,100], equals the common value when all inputs are equal, and equals `0` for `[]`

  - [x] 1.3 Write property test for ring fill proportionality
    - **Property 3: Ring fill is proportional and monotonic**
    - **Validates: Requirements 2.3**
    - fast-check, 100+ runs; tag `Feature: upload-status-bar, Property 3: Ring fill is proportional and monotonic`
    - Assert offset lies in [0, circumference], decreases monotonically as percent increases, equals circumference at 0%, equals 0 at 100%

  - [x] 1.4 Write property test for done-count
    - **Property 4: Done-count text reflects success count out of batch total**
    - **Validates: Requirements 3.2**
    - fast-check, 100+ runs; tag `Feature: upload-status-bar, Property 4: Done-count text reflects success count out of batch total`
    - Assert `doneCount` equals the number of `success` items, never exceeds total, and the formatted string is exactly `"{done} de {total}"`

- [x] 2. Implement scoped store selectors
  - [x] 2.1 Add scoped selectors reading `useUploadStore`
    - In `app/components/upload-status.ts` (or the component file), define `selectActiveUploadCount = (s: UploadStore) => activeUploadCount(s.items)` returning a primitive number
    - Define `selectAggregateProgress = (s: UploadStore) => ({ done, total, percent })` using `doneCount`, batch size (`s.items.length`), and `aggregateProgress(s.items.map(i => i.progress))`
    - Consume the aggregate selector at the call site with `useShallow` (from `zustand/react/shallow`) so a progress tick that does not change rounded percent/done/total does not re-render
    - Follow the existing per-field/narrow-selector subscription pattern used by `media-item-placeholder.tsx`
    - _Requirements: 5.1, 5.2_

- [x] 3. Implement the phase state machine and auto-hide timer
  - [x] 3.1 Implement `UploadStatusBar` phase latch in `app/components/upload-status-bar.tsx`
    - Create the client component (`"use client"`), no props, default export returning `React.ReactElement | null`
    - Subscribe via `selectActiveUploadCount` (primitive) and `selectAggregateProgress` (with `useShallow`)
    - Add local state `phase: "hidden" | "active" | "completion"`, a `hasBeenActive` flag, and a `useRef` holding the auto-hide `setTimeout` handle
    - In an effect keyed on `activeCount`: when `> 0`, clear any pending hide timer, set `phase = "active"`, set `hasBeenActive = true`; when `=== 0` and `phase === "active"` and `hasBeenActive`, set `phase = "completion"` and start a 5s timer that sets `phase = "hidden"` and resets `hasBeenActive`
    - Handle Req 4.6 re-entry: a new active upload during completion clears the timer and returns to `active`
    - Clear the timer on unmount
    - Return `null` while `phase === "hidden"`
    - _Requirements: 1.1, 1.2, 1.3, 4.1, 4.4, 4.5, 4.6_

  - [x] 3.2 Write property test for the phase/visibility state machine
    - **Property 1: Phase/visibility state machine**
    - **Validates: Requirements 1.1, 1.2, 1.3, 4.1, 4.4, 4.6**
    - fast-check, 100+ runs; tag `Feature: upload-status-bar, Property 1: Phase/visibility state machine`
    - Model the transition function over generated sequences of snapshots (arbitrary item statuses); assert: active-count > 0 ⇒ phase `active`/visible; drop to 0 after active ⇒ `completion` regardless of failed/exhausted/canceled/success; a new active during completion ⇒ back to `active` and cancels pending hide; hidden only when no active and no completion in effect
    - Extract the pure transition logic so it can be tested without React timers, or drive it with fake timers

  - [x] 3.3 Write unit test for the 5s auto-hide timer
    - Use Vitest fake timers + Testing Library `render`
    - Enter completion, advance 5s ⇒ component hidden (returns null); advance < 5s ⇒ still visible
    - Assert re-entry (new active during completion) cancels the pending hide
    - _Requirements: 4.5, 4.6_

- [x] 4. Implement the rendered pill UI
  - [x] 4.1 Render Progress_Ring, percentage, and completion checkmark
    - In `app/components/upload-status-bar.tsx`, render the inline SVG ring (R=20, `C = 2*Math.PI*R`, `strokeDashoffset = ringDashOffset(percent, C)`), matching the pattern in `media-item-placeholder.tsx` / navbar download button
    - Use palette tokens: track `#F8D6E4`, fill `#E83E8C`; apply the `transition-[stroke-dashoffset]` so fill updates on percent change
    - While `phase === "active"`: show `${percent}%` centered inside the ring
    - While `phase === "completion"`: swap the percentage for a centered inline SVG checkmark (stroke `#E83E8C`), ring shown full
    - _Requirements: 2.1, 2.3, 2.4, 2.5, 4.2_

  - [x] 4.2 Render the two Spanish text rows and completion message
    - To the right of the ring, a vertical stack of two rows
    - Active phase: Row 1 = `` `${done} de ${total}` ``; Row 2 = `No cierres ni recargues la página`
    - Completion phase: replace the rows with a Spanish done message (e.g. `¡Subida completada!`)
    - Ensure all displayed text is Spanish
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 4.3_

  - [x] 4.3 Apply positioning and responsive width classes
    - Outer wrapper `fixed bottom-4 left-0 right-0` at `z-[101]` so it layers over the Filter_Pill (`z-[100]`) and above the `z-[99]` gradient
    - Mobile (`< md:`): pill spans full width (`w-full`, edge padding `px-4`)
    - Desktop (`≥ md:`): center and size to content (`md:w-auto md:left-1/2 md:-translate-x-1/2`, `w-fit` on the pill)
    - _Requirements: 1.4, 1.5, 1.6_

  - [x] 4.4 Write render/example tests for the pill
    - Ring + two rows render while active; `${percent}%` shown inside the ring (Req 2.1, 2.4, 3.1)
    - Spanish warning row present while active; checkmark + Spanish done message in completion (Req 3.3, 4.2, 4.3, 3.4)
    - Correct fixed + `z-[101]` classes over the pill; full-width mobile vs content-width desktop classes (Req 1.4, 1.5, 1.6)
    - _Requirements: 2.1, 2.4, 3.1, 3.3, 3.4, 4.2, 4.3, 1.4, 1.5, 1.6_

  - [x] 4.5 Write re-render count test for scoped subscription
    - Mount the bar plus an unrelated subscriber; dispatch a progress-only store tick that does not change rounded percent/done/total
    - Assert the unrelated subscriber does not re-render on the progress tick
    - _Requirements: 5.1_

- [x] 5. Integrate into the navbar
  - [x] 5.1 Render `<UploadStatusBar/>` in the "Barra normal" branch of `app/components/navbar.tsx`
    - Import and render the component as a sibling of the Filter_Pill `Card` and the Upload_Button, inside the "Barra normal" branch
    - Confirm it layers over the Filter_Pill at `z-[101]` and does not cover the trailing Upload_Button
    - Preserve existing navbar behavior (the stable `enqueueFiles` selector, isDemo gating)
    - _Requirements: 1.4_

- [x] 6. Checkpoint - Ensure the status bar works end to end
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Fix the desktop Upload_Button (Req 6)
  - [x] 7.1 Confirm the root cause at runtime, then apply a minimal `md:`-only fix in `app/components/navbar.tsx`
    - First confirm the cause at a `≥ md:` viewport (`yarn dev`, DevTools): inspect the `TbPhotoPlus` button — verify it is in the DOM, its computed `md:bg-pink-200!` fill vs `md:text-[#E83E8C]!` icon contrast on `#FFFCF8`, and its stacking context vs the `z-[99]` gradient / `z-[100]` row / new `z-[101]` bar
    - Apply the smallest fix addressing the confirmed cause: give the desktop state a legible fill/icon pairing (e.g. `md:bg-pink-500!` + `md:text-white!` if contrast is the cause) and/or correct the stacking so the button is not covered
    - Touch only `md:` classes; leave mobile classes (`bg-pink-500/90!`, `text-white!`) unchanged (Req 6.4)
    - Keep the button inside `{!isDemo && (...)}` and preserve the `onClick={() => fileInputRef.current?.click()}` handler (Req 6.1, 6.3)
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

  - [x] 7.2 Write example tests for the Upload_Button
    - Visible for non-demo at `md:`; absent for demo (Req 6.1)
    - Click opens the file picker (`fileInputRef.current?.click()` invoked) (Req 6.3)
    - Mobile classes unchanged (Req 6.4)
    - _Requirements: 6.1, 6.3, 6.4_

- [x] 8. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test tasks and can be skipped for a faster MVP.
- Property tests validate the 4 universal correctness properties from the design; each references its property number and the requirements it validates.
- Unit/example tests cover rendering, Spanish copy, the 5s fake-timer behavior, responsive classes, re-render scoping, and the upload-button fix.
- Req 6.2 (desktop contrast) is confirmed by a runtime visual check during task 7.1, not by an automated assertion.
- Per `AGENTS.md`, consult `node_modules/next/dist/docs/` before writing code touching Next.js APIs/conventions; the bar is client-only within the existing `"use client"` boundary.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4", "2.1"] },
    { "id": 2, "tasks": ["3.1"] },
    { "id": 3, "tasks": ["3.2", "3.3", "4.1"] },
    { "id": 4, "tasks": ["4.2", "4.3"] },
    { "id": 5, "tasks": ["4.4", "4.5", "5.1"] },
    { "id": 6, "tasks": ["7.1"] },
    { "id": 7, "tasks": ["7.2"] }
  ]
}
```
