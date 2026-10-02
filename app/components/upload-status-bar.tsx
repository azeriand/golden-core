"use client";

import { useEffect, useRef, useState } from "react";
import useUploadStore from "@/app/src/stores/upload.store";
import { useShallow } from "zustand/react/shallow";
import {
  ringDashOffset,
  selectActiveUploadCount,
  selectAggregateProgress,
} from "./upload-status";

// ---------------------------------------------------------------------------
// upload-status-bar.tsx — Task 3.1
//
// Client-only aggregate upload status bar. A PURE VIEW over the Upload_Store:
// it derives everything it shows (aggregate progress, done-count) via scoped
// selectors and owns only presentation-transient phase/timer state.
//
// This task implements the phase state machine + 5s auto-hide timer (Req 1 +
// Req 4). The visible pill/ring/text UI is filled in by tasks 4.1-4.3; for now
// the active/completion phases render a minimal structural placeholder so the
// subsequent tasks have a stable shape to build on.
// ---------------------------------------------------------------------------

/** Presentation-only lifecycle phase of the bar. */
export type Phase = "hidden" | "active" | "completion";

/** Fixed 5-second auto-hide delay once the bar enters completion (Req 4.5). */
export const AUTO_HIDE_DELAY_MS = 5000;

/**
 * Pure phase-transition state used by the reducer below. This is extracted from
 * React so the state machine (Property 1, task 3.2) can be exercised without
 * timers or a renderer. `hasBeenActive` gates the completion latch so the bar
 * never shows completion on first mount over an empty store (Req 4.1).
 */
export interface PhaseState {
  phase: Phase;
  hasBeenActive: boolean;
}

export const INITIAL_PHASE_STATE: PhaseState = {
  phase: "hidden",
  hasBeenActive: false,
};

/**
 * Pure transition for the phase latch driven by the current Active_Upload count.
 * Returns the next phase state AND whether the caller should (re)start the 5s
 * auto-hide timer (`startHideTimer`) or clear any pending one (`clearHideTimer`).
 *
 *   activeCount > 0                         -> "active"; cancel any pending hide
 *                                              (Req 1.1/1.3/4.6 re-entry).
 *   activeCount === 0 && was "active"       -> "completion"; start the 5s hide
 *     && hasBeenActive                         timer (Req 4.1/4.4/4.5).
 *   otherwise                               -> unchanged.
 */
export function nextPhase(
  state: PhaseState,
  activeCount: number
): { state: PhaseState; startHideTimer: boolean; clearHideTimer: boolean } {
  if (activeCount > 0) {
    // A new/continuing active upload always shows progress and cancels any
    // pending auto-hide (Req 4.6 re-entry from completion returns to active).
    return {
      state: { phase: "active", hasBeenActive: true },
      startHideTimer: false,
      clearHideTimer: true,
    };
  }

  // activeCount === 0.
  if (state.phase === "active" && state.hasBeenActive) {
    // The run just drained to zero (regardless of failed/exhausted/canceled/
    // success outcomes) — latch completion and arm the auto-hide timer.
    return {
      state: { phase: "completion", hasBeenActive: true },
      startHideTimer: true,
      clearHideTimer: false,
    };
  }

  // Already hidden or already in completion: no change (the running timer, if
  // any, continues toward hiding).
  return { state, startHideTimer: false, clearHideTimer: false };
}

export default function UploadStatusBar(): React.ReactElement | null {
  // Scoped store subscriptions (Req 5.1). The active count is a primitive, so it
  // re-renders only when the count changes — not on progress-only ticks. The
  // aggregate is a derived object consumed with useShallow so a progress tick
  // that leaves the rounded percent/done/total unchanged does not re-render.
  const activeCount = useUploadStore(selectActiveUploadCount);
  const { done, total, percent } = useUploadStore(
    useShallow(selectAggregateProgress)
  );

  const [state, setState] = useState<PhaseState>(INITIAL_PHASE_STATE);
  const { phase } = state;

  // Holds the pending auto-hide setTimeout handle so it can always be cleared on
  // re-entry (Req 4.6) and on unmount.
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Drive the phase latch off transitions in activeCount (Req 1 + Req 4).
  useEffect(() => {
    setState((prev) => {
      const { state: next, startHideTimer, clearHideTimer } = nextPhase(
        prev,
        activeCount
      );

      if (clearHideTimer && hideTimerRef.current !== null) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }

      if (startHideTimer) {
        if (hideTimerRef.current !== null) clearTimeout(hideTimerRef.current);
        hideTimerRef.current = setTimeout(() => {
          hideTimerRef.current = null;
          // After the auto-hide delay, hide and reset the run latch so the next
          // batch starts fresh (Req 4.5).
          setState({ phase: "hidden", hasBeenActive: false });
        }, AUTO_HIDE_DELAY_MS);
      }

      return next;
    });
  }, [activeCount]);

  // Clear the timer on unmount so it can never fire against an unmounted
  // component or leak.
  useEffect(() => {
    return () => {
      if (hideTimerRef.current !== null) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    };
  }, []);

  // Nothing to render while hidden — adds nothing to the layout when idle.
  if (phase === "hidden") return null;

  const isCompletion = phase === "completion";

  // Progress_Ring geometry (Req 2.1/2.3). Matches the pattern used by
  // media-item-placeholder.tsx and the navbar download button: an inline SVG
  // ring, radius 20, circumference 2*pi*R, filled via strokeDashoffset. In the
  // completion phase the ring is shown full (offset for 100%).
  const RADIUS = 20;
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
  const dashOffset = ringDashOffset(isCompletion ? 100 : percent, CIRCUMFERENCE);

  return (
    // Outer positioning wrapper (task 4.3). Fixed to the bottom at bottom-24 so
    // it sits ABOVE the Filter_Pill row (stacked, not overlapping) — the pill
    // row lives at bottom-4, so bottom-24 clears it with a gap. Still layered at
    // z-[101] so it renders above the Filter_Pill (z-[100]) and the z-[99] blur
    // gradient (see navbar.tsx). Mobile: spans the full width with edge padding
    // (Req 1.5). Desktop (>= md:): right-auto drops the right-0 stretch so the
    // wrapper collapses to fit the pill content, left-aligned with navbar padding.
    <div className="fixed bottom-24 left-0 right-0 z-[101] px-4 md:right-auto md:px-6">
      {/* The pill itself: full width on mobile, content width on desktop, with
          rounded-full pill styling consistent with the Filter_Pill Card. */}
      <div
        data-phase={phase}
        data-percent={percent}
        data-done={done}
        data-total={total}
        className="flex w-full items-center gap-3 rounded-full bg-[#FFFCF8]/95 p-3 shadow-lg backdrop-blur-md md:w-fit md:pr-6"
      >
        {/* Progress_Ring + centered label (percentage while active, checkmark
            in completion). */}
        <div className="relative flex h-12 w-12 shrink-0 items-center justify-center">
          <svg
            width="48"
            height="48"
            viewBox="0 0 48 48"
            className="-rotate-90"
            aria-hidden="true"
          >
            {/* Track */}
            <circle
              cx="24"
              cy="24"
              r={RADIUS}
              fill="none"
              stroke="#F8D6E4"
              strokeWidth="4"
            />
            {/* Fill — proportional to aggregate progress; animates on change. */}
            <circle
              cx="24"
              cy="24"
              r={RADIUS}
              fill="none"
              stroke="#E83E8C"
              strokeWidth="4"
              strokeLinecap="round"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={dashOffset}
              className="transition-[stroke-dashoffset] duration-200 ease-out"
            />
          </svg>

          {/* Centered label inside the ring. */}
          {isCompletion ? (
            <svg
              className="absolute"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
              data-testid="upload-status-checkmark"
            >
              <path
                d="M5 13l4 4L19 7"
                stroke="#E83E8C"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <span className="absolute text-xs font-medium text-[#E83E8C]">
              {percent}%
            </span>
          )}
        </div>

        {/* Two Spanish text rows while active (done-count + warning); a single
            Spanish done message in completion (Req 3.1-3.4, 4.3). */}
        <div className="flex min-w-0 flex-col justify-center">
          {isCompletion ? (
            <span className="text-sm font-semibold text-[#E83E8C]">
              ¡Subida completada!
            </span>
          ) : (
            <>
              <span className="text-sm font-semibold text-neutral-800">
                {`${done} de ${total}`}
              </span>
              <span className="text-xs text-neutral-500">
                No cierres ni recargues la página
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
