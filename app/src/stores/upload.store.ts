import { create } from "zustand";
import { Media } from "@/app/dto/media";
import useGlobalStore from "./global.store";
import useEventStore from "./event.store";
import useAuthStore from "./auth.store";
import { uploadToBlob, type BlobUploadResult } from "@/lib/blob-upload-client";
import { uploadQueue, type QueueRecord, type QueueStatus } from "@/lib/upload-queue";

// ---------------------------------------------------------------------------
// upload.store.ts — Task 9.2 (design Component 7)
//
// Orchestrates the NEW direct-to-Blob upload path for a single file:
//   enqueue -> (persist 'queued') -> preprocess+upload (uploadToBlob) ->
//   persist blobUrl -> confirm (POST /media/confirm) -> append Media to
//   useEventStore + remove queue record -> mark completed ('success').
//
// COMPLETION CONSISTENCY (Req 20/21): an item is only marked completed
// (UI literal 'success') AFTER the confirm endpoint succeeds (200 or 201).
// A resolved Blob upload alone is NEVER treated as completed. If the Blob
// upload succeeds but confirm fails, the item is marked 'failed', the failure
// (including the persisted blobUrl) is kept in the IndexedDB queue for later
// confirm-only recovery (Task 9.4), and the SAME uploadId is preserved.
//
// uploadId LIFECYCLE (D3, Req 7.1/7.2): exactly one uploadId (UUID v4) is
// generated per item at enqueue time (item.id === uploadId) and reused as-is
// for the Blob upload, the queue record, the confirm body, and retry. It is
// NEVER regenerated.
//
// STATUS MODEL: the persisted design lifecycle is
// 'queued'|'processing'|'uploading'|'completed'|'failed' (+ 'canceled' as
// store-only behavior). The EXISTING UI (media-item-placeholder.tsx,
// masonry.tsx) switches on the legacy literals 'success'|'exhausted' and reads
// 'uploading'|'failed'. To avoid touching UI components (constraints 1/17), the
// store's public `UploadItem.status` is a SUPERSET that keeps those legacy
// literals: design `completed` is surfaced as `success`, retry-exhaustion as
// `exhausted`. `processing`/`canceled` are added. Mapping to the persisted
// QueueStatus is done at the persistence boundary only.
//
// LEGACY PATH: the legacy XHR uploader (app/upload-xhr.ts) and the legacy
// route (POST /api/event/[slug]/media) are intentionally left intact and
// callable; this store now drives the new Blob path as its upload mechanism.
// ---------------------------------------------------------------------------

export type UploadStatus =
  | "queued"
  | "processing"
  | "uploading"
  | "success" // == design 'completed' (kept for existing UI)
  | "failed"
  | "exhausted" // retry cap reached (kept for existing UI)
  | "canceled";

export interface UploadItem {
  id: string; // == uploadId (UUID v4)
  file: File;
  previewUrl: string;
  status: UploadStatus;
  progress: number; // 0-100
  originalSize: number;
  processedSize: number | null;
  contentType: string;
  retryCount: number;
  error: string | null;
  abort: AbortController | null;
  mediaResult: Media | null;
  /**
   * Client BlurHash (Change 2). Computed during preprocessing and threaded into
   * the confirm body; also persisted to the queue record so recovery/auto-resume
   * confirm bodies carry it. null for videos/non-images/failed generation.
   */
  blurhash: string | null;
  /**
   * RECOVERY PREVIEW (Change 3d). A data URL thumbnail persisted at enqueue for
   * records whose bytes are NOT stored (video / oversized image), so a surfaced
   * recovery item shows a real preview instead of a blank placeholder. null for
   * live items and byte-persisted images (those preview via previewUrl / bytes).
   */
  thumbnailDataUrl: string | null;
  /**
   * RECOVERY CLASSIFICATION (Change 3d). Marks how a surfaced recovery item
   * should behave in the placeholder UI, distinct from `status`:
   *   - 'confirm-retry': has a Blob but confirm failed -> preview + tap-to-retry
   *     (re-runs confirm only, via retryConfirm).
   *   - 'inert': video/oversized image with no bytes -> thumbnail + tap-to-dismiss.
   *   - null: a normal (non-recovery) item.
   */
  recovery: "confirm-retry" | "inert" | null;
  /**
   * ENQUEUE-TIME DATE (Req 6.4/6.6, 14.4/14.10). ISO-8601 timestamp captured
   * exactly ONCE when the item is created in `enqueueFiles`, stable for the
   * item's whole lifecycle. It is the SINGLE date value used by (a) the
   * persisted QueueRecord, (b) the same-session confirm body, and (c) — after a
   * reload — confirm-only recovery. Retry reuses the same item (same id AND same
   * date); it is never recomputed. This is an internal field; the UI does not
   * read it.
   */
  date: string;
  /**
   * STALE-ASYNC GUARD (Task 9.3). A monotonically increasing token identifying
   * the CURRENT attempt for this item. `processOne` captures this value when it
   * starts; every subsequent state write it performs first re-reads the live
   * item and checks that the item still exists AND its `attempt` still equals
   * the captured value. A retry bumps `attempt` (new attempt), and
   * cancel/dismiss also bump it (invalidating the in-flight attempt) so any
   * late async continuation from a superseded/removed attempt no-ops: it cannot
   * write progress, persist a blobUrl, confirm, append media, flip status, or
   * release a concurrency slot it no longer owns. This is intentionally the
   * smallest viable mechanism (a per-item integer version) — no external state
   * machine, no added abstraction. It is an internal field; the UI never reads
   * it, so adding it does not affect UI compatibility.
   */
  attempt: number;
}

export interface UploadStore {
  items: UploadItem[];
  activeCount: number;
  /**
   * True when cross-reload recovery surfaced at least one INERT item that cannot
   * be auto-resumed (a video, or an image over the resumable size cap — neither
   * persists bytes). The page shows a one-time Spanish popup explaining these
   * must be re-uploaded manually. Set by recoverInterrupted; cleared by
   * dismissRecoveryNotice.
   */
  recoveryNotice: boolean;

  enqueueFiles: (files: File[], eventSlug: string) => void;
  retryItem: (id: string) => void;
  /**
   * Re-run the idempotent confirm (NO Blob re-upload) for a surfaced recovery
   * item whose Blob already exists but whose confirm failed
   * (recovery === 'confirm-retry'). Reuses the SAME uploadId, so a duplicate row
   * can never be created (dedupe by upload_id). On success appends the Media and
   * removes the record+bytes; on failure keeps the item surfaced with a message.
   */
  retryConfirm: (id: string) => void;
  dismissItem: (id: string) => void;
  cancelItem: (id: string) => void;
  processQueue: () => void;
  /**
   * Cross-reload recovery entry point (Task 9.4, design Component 7 +
   * `recoverInterrupted` pseudocode; Req 14). Reads persisted intent from the
   * IndexedDB queue on app start and SURFACES interrupted records to the user —
   * it NEVER auto-resumes a byte stream, never silently re-uploads, never
   * auto-confirms, never marks success, and never mints a new uploadId
   * (Req 14.1/14.2/14.8, design D4). See the implementation for the three
   * distinct recovery behaviors and the confirm-only limitation.
   *
   * Idempotent + run-once: guarded so React Strict Mode's double-invoke and
   * repeated renders can only ever trigger a single recovery pass.
   */
  recoverInterrupted: (eventSlug: string) => Promise<void>;
  /** Dismiss the recovery notice popup (see recoveryNotice). */
  dismissRecoveryNotice: () => void;
}

const MAX_CONCURRENT = 3;
const MAX_RETRIES = 3;

/**
 * Byte-persistence size cap for transparent auto-resume (Change 3a). Images at
 * or below this size have their ACTUAL upload bytes persisted in IndexedDB so a
 * mid-upload reload can auto-resume the same uploadId without a reselect. Videos
 * and images ABOVE this cap never persist bytes — only a small preview thumbnail
 * is stored so recovery can show it with a dismissable warning.
 */
const RESUMABLE_MAX_BYTES = 20 * 1024 * 1024; // 20 MB

/** Longest edge of the persisted recovery thumbnail (video/oversized image). */
const THUMBNAIL_MAX_EDGE = 320;

/** True for a file whose MIME marks it an image (mirrors the server/preprocess). */
function isImageMime(type: string): boolean {
  return typeof type === "string" && type.startsWith("image/");
}

/** True for a file whose MIME marks it a video. */
function isVideoMime(type: string): boolean {
  return typeof type === "string" && type.startsWith("video/");
}

/**
 * Compute target dimensions preserving aspect ratio so neither exceeds maxEdge.
 */
function fitWithin(
  width: number,
  height: number,
  maxEdge: number
): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width, height };
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Best-effort downscaled JPEG data URL preview of an image File, for surfaced
 * recovery items whose bytes are NOT persisted (oversized images). Fully
 * feature-detected and wrapped so ANY failure (SSR, no canvas, decode error)
 * resolves to null and the upload/enqueue proceeds normally. Never throws.
 */
async function makeImageThumbnail(file: File): Promise<string | null> {
  try {
    if (
      typeof createImageBitmap !== "function" ||
      typeof document === "undefined" ||
      typeof document.createElement !== "function"
    ) {
      return null;
    }
    const bitmap = await createImageBitmap(file, {
      imageOrientation: "from-image",
    });
    try {
      const { width, height } = fitWithin(
        bitmap.width,
        bitmap.height,
        THUMBNAIL_MAX_EDGE
      );
      if (width <= 0 || height <= 0) return null;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(bitmap, 0, 0, width, height);
      return canvas.toDataURL("image/jpeg", 0.6);
    } finally {
      if (typeof bitmap.close === "function") bitmap.close();
    }
  } catch {
    return null;
  }
}

/**
 * Best-effort captured poster-frame data URL for a video File, for surfaced
 * recovery items (videos never persist bytes). Loads the video off-DOM, seeks a
 * touch past the start, and paints the current frame to a canvas. Fully guarded
 * so ANY failure resolves to null (recovery then shows a generic placeholder).
 * Never throws.
 */
async function makeVideoThumbnail(file: File): Promise<string | null> {
  try {
    if (
      typeof document === "undefined" ||
      typeof document.createElement !== "function" ||
      typeof URL === "undefined" ||
      typeof URL.createObjectURL !== "function"
    ) {
      return null;
    }
    const objectUrl = URL.createObjectURL(file);
    try {
      const dataUrl = await new Promise<string | null>((resolve) => {
        const video = document.createElement("video");
        video.muted = true;
        video.preload = "metadata";
        let settled = false;
        const done = (value: string | null) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        // Safety timeout so a stuck decode never hangs enqueue.
        const timer = setTimeout(() => done(null), 3000);
        video.onloadeddata = () => {
          try {
            const { width, height } = fitWithin(
              video.videoWidth || 0,
              video.videoHeight || 0,
              THUMBNAIL_MAX_EDGE
            );
            if (width <= 0 || height <= 0) {
              clearTimeout(timer);
              return done(null);
            }
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext("2d");
            if (!ctx) {
              clearTimeout(timer);
              return done(null);
            }
            ctx.drawImage(video, 0, 0, width, height);
            clearTimeout(timer);
            done(canvas.toDataURL("image/jpeg", 0.6));
          } catch {
            clearTimeout(timer);
            done(null);
          }
        };
        video.onerror = () => {
          clearTimeout(timer);
          done(null);
        };
        video.src = objectUrl;
        // Nudge decoding of the first frame.
        try {
          video.currentTime = 0.1;
        } catch {
          /* ignore: some browsers seek on play only */
        }
      });
      return dataUrl;
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  } catch {
    return null;
  }
}

/**
 * Module-level run-once guard for cross-reload recovery (Task 9.4). Recovery
 * reads the persisted queue exactly once per page load. React Strict Mode
 * double-invokes effects in development and components re-render frequently, so
 * a plain effect would call `recoverInterrupted` multiple times; this flag makes
 * every call after the first a no-op regardless of how many times the bootstrap
 * effect fires. It is a module-level primitive (not a second concurrency
 * manager) that is reset only by a real page reload — which is exactly the
 * boundary at which a fresh recovery pass is meaningful.
 */
let recoveryHasRun = false;

/**
 * Map the store's UI-facing status to the persisted QueueStatus union
 * ('queued'|'processing'|'uploading'|'completed'|'failed'). There is no
 * 'canceled' in the persisted queue (cancellation removes the record).
 */
function toQueueStatus(status: UploadStatus): QueueStatus {
  switch (status) {
    case "success":
      return "completed";
    case "queued":
    case "processing":
    case "uploading":
    case "failed":
      return status;
    case "exhausted":
    case "canceled":
      // Neither is a persisted lifecycle state; treat as a failed record.
      return "failed";
  }
}

/** Build a full QueueRecord snapshot for an item (never stores bytes). */
function toRecord(
  item: UploadItem,
  eventSlug: string,
  status: UploadStatus
): QueueRecord {
  const kind: "image" | "video" = isVideoMime(item.contentType)
    ? "video"
    : "image";
  const oversized =
    kind === "image" && item.originalSize > RESUMABLE_MAX_BYTES;
  // Bytes are persisted ONLY for resumable images (image AND <= cap). This
  // mirrors the enqueue-time policy so the record's hasBytes flag matches what
  // is actually stored in the bytes store (Change 3a).
  const hasBytes = kind === "image" && !oversized;
  return {
    uploadId: item.id,
    eventSlug,
    filename: item.file.name,
    contentType: item.contentType,
    originalSize: item.originalSize,
    processedSize: item.processedSize,
    status: toQueueStatus(status),
    blobUrl: null,
    // Persist the client BlurHash so recovery/auto-resume confirm bodies carry
    // it (Change 2 pt4). null until preprocessing produces one.
    blurhash: item.blurhash,
    error: item.error,
    // Recovery-UX metadata (Change 3): classification + byte/thumbnail policy.
    kind,
    oversized,
    hasBytes,
    thumbnailDataUrl: item.thumbnailDataUrl,
    // Enqueue-time upload-intent date (Req 6.4/6.6). Always the item's captured
    // date — never substituted with updatedAt/now — so every persisted snapshot
    // carries the same immutable value.
    date: item.date,
    updatedAt: Date.now(),
  };
}

/** Append a confirmed Media row to the event store, mirroring the legacy path. */
function appendMediaToEventStore(media: Media): void {
  const eventState = useEventStore.getState();
  if (!eventState.event) return;

  const sections = eventState.event.sections.map((section) => {
    if (String(section.section_id) === String(media.section_id)) {
      return { ...section, media: [...section.media, media] };
    }
    return section;
  });

  // If media has no matching section, fall back to the first section.
  const added = sections.some((s) => s.media.includes(media));
  if (!added && sections.length > 0) {
    sections[0] = { ...sections[0], media: [...sections[0].media, media] };
  }

  useEventStore.setState({ event: { ...eventState.event, sections } });
}

/**
 * Build an INERT, bytes-less surfaced UploadItem for cross-reload recovery
 * (Task 9.4). Reuses the persisted `uploadId` (NEVER mints a new one) and the
 * 'exhausted' status (an EXISTING public status the placeholder UI renders as
 * dismiss-on-tap), with retryCount at the cap so the UI never auto-starts an
 * upload of the absent bytes. The persisted enqueue-time `date` is preserved
 * when present (defensively defaulting to an empty string for a legacy date-less
 * record — the surfaced item is inert and never confirmed by the store, so the
 * empty value is never sent anywhere).
 */
function buildRecoverySurfaceItem(
  r: QueueRecord,
  placeholderFile: File,
  message: string,
  recovery: "confirm-retry" | "inert"
): UploadItem {
  return {
    id: r.uploadId, // preserve the persisted uploadId — NEVER mint a new one
    file: placeholderFile,
    previewUrl: "",
    // Surfaced recovery items use the EXISTING terminal 'exhausted'/'failed'
    // public statuses the placeholder UI already renders; the `recovery` marker
    // (not status) selects the exact UX (tap-to-retry vs tap-to-dismiss).
    status: recovery === "confirm-retry" ? "failed" : "exhausted",
    progress: 0,
    originalSize: r.originalSize,
    processedSize: r.processedSize,
    contentType: r.contentType,
    // At the cap so the placeholder tap handler never auto-starts an upload of
    // absent bytes; retry routing for confirm-retry goes through retryConfirm.
    retryCount: MAX_RETRIES,
    error: message,
    abort: null,
    mediaResult: null,
    blurhash: typeof r.blurhash === "string" ? r.blurhash : null,
    // Show the persisted thumbnail (video/oversized image) if present.
    thumbnailDataUrl:
      typeof r.thumbnailDataUrl === "string" ? r.thumbnailDataUrl : null,
    recovery,
    date: typeof r.date === "string" ? r.date : "",
    attempt: 0,
  };
}

/**
 * Terminal statuses from which a retry is allowed. Retry is a NO-OP from any
 * other state (in particular `queued`/`processing`/`uploading`/`success`/
 * `canceled`), so a retry can never double-start an in-flight attempt, occupy
 * a second concurrency slot, resurrect a canceled item, or duplicate a
 * completed one (Task 9.3, Req 10.4/13.2).
 */
const RETRYABLE_STATUSES: ReadonlySet<UploadStatus> = new Set<UploadStatus>([
  "failed",
  "exhausted",
]);

const useUploadStore = create<UploadStore>((set, get) => {
  /** Patch a single item in-place by id. */
  const patchItem = (id: string, partial: Partial<UploadItem>) => {
    set((state) => ({
      items: state.items.map((i) => (i.id === id ? { ...i, ...partial } : i)),
    }));
  };

  /**
   * Apply the enqueue-time byte-persistence policy for one item (Change 3a).
   * Best-effort and swallow-safe: any failure is a no-op (uploads still work,
   * just without cross-reload resume/thumbnail). Runs AFTER the item is in the
   * store so it can patch the item + persisted record with a computed thumbnail.
   *
   *   image <= cap  -> persist the actual bytes (transparent auto-resume).
   *   video/oversized -> persist ONLY a preview thumbnail (no bytes).
   */
  const persistEnqueuePayload = async (item: UploadItem, eventSlug: string) => {
    const type = item.contentType;
    const isImage = isImageMime(type);
    const oversized = isImage && item.originalSize > RESUMABLE_MAX_BYTES;

    // Persist the metadata record for EVERY enqueued item RIGHT AWAY (status
    // 'queued'). This is essential for items that sit behind the MAX_CONCURRENT
    // cap: they never enter processOne (which is where the record used to be
    // first written), so without this a mid-upload refresh would find no record
    // for them and they would vanish instead of resuming. processOne still
    // patches status transitions later for the active ones. Best-effort.
    void uploadQueue.put(toRecord(item, eventSlug, "queued"));

    if (isImage && !oversized) {
      // Resumable image: persist the actual bytes to the separate bytes store.
      // We persist the ORIGINAL File here; when auto-resume runs it drives the
      // SAME uploadToBlob path, which re-preprocesses images before upload, so
      // the resumed upload is byte-equivalent to a fresh one.
      await uploadQueue.putBytes(item.id, item.file);
      return;
    }

    // Video OR oversized image: no bytes. Compute a small preview thumbnail so
    // recovery can show it with a dismissable warning. Patch both the in-memory
    // item and the persisted record (which processOne's put may have already
    // written without the thumbnail).
    let thumb: string | null = null;
    if (isImage) {
      thumb = await makeImageThumbnail(item.file);
    } else if (isVideoMime(type)) {
      thumb = await makeVideoThumbnail(item.file);
    }
    if (thumb) {
      patchItem(item.id, { thumbnailDataUrl: thumb });
      await uploadQueue.patch(item.id, { thumbnailDataUrl: thumb });
    }
    // eventSlug is accepted for symmetry / future per-event policy; unused today.
    void eventSlug;
  };

  /**
   * STALE-ASYNC GUARD core check. Returns true iff the item `id` still exists
   * AND its live `attempt` token still equals the `attempt` captured when the
   * current `processOne` started. Any write guarded by this becomes a no-op for
   * a superseded attempt (retried), an invalidated attempt (canceled/dismissed
   * bump the token), or a removed item (dismissed). This is the single
   * primitive that prevents every stale-continuation race in Task 9.3.
   */
  const isCurrentAttempt = (id: string, attempt: number): boolean => {
    const item = get().items.find((i) => i.id === id);
    return item != null && item.attempt === attempt;
  };

  /**
   * Batch progress updates to whole-percent changes to limit re-renders while
   * preserving the UI's expected 0-100 number shape. Guarded so a stale
   * continuation's late progress callback cannot move a newer attempt's ring.
   */
  const setProgress = (id: string, attempt: number, pct: number) => {
    if (!isCurrentAttempt(id, attempt)) return;
    const next = Math.max(0, Math.min(100, Math.floor(pct)));
    const current = get().items.find((i) => i.id === id);
    if (!current || current.progress === next) return;
    patchItem(id, { progress: next });
  };

  /**
   * Orchestrate a single item end-to-end. Assumes the caller has already:
   * bumped the item's `attempt`, marked it `uploading`, attached a FRESH
   * AbortController, and incremented `activeCount` for exactly one slot.
   *
   * EVERY state write below is guarded by the captured `attempt` token so a
   * stale continuation (from an attempt that was retried, canceled, or
   * dismissed, or from an item that was removed) can NEVER: write progress,
   * persist a blobUrl, confirm, append media, flip status, or release/double-
   * release a concurrency slot it no longer owns. The slot is released EXACTLY
   * ONCE — and only by the attempt that still owns it.
   */
  const processOne = async (id: string, attempt: number, eventSlug: string) => {
    const startItemSnapshot = get().items.find((i) => i.id === id);
    if (!startItemSnapshot) return;

    // Resolve the numeric eventId from the event store (required to build the
    // canonical Blob pathname and pass the confirm/blob-belongs-to-event check).
    const eventId = useEventStore.getState().event?.event_id;

    /**
     * Finalize this attempt: release its slot (exactly once, only if it still
     * owns the current attempt) and apply the final status/patch. If the token
     * is stale (retried/canceled/dismissed/removed), do NOTHING — the attempt
     * that superseded/invalidated this one owns the slot and the final state.
     */
    const release = (finalStatus: UploadStatus, patch: Partial<UploadItem>) => {
      if (!isCurrentAttempt(id, attempt)) return;
      set((state) => ({
        activeCount: Math.max(0, state.activeCount - 1),
        items: state.items.map((i) =>
          i.id === id ? { ...i, status: finalStatus, abort: null, ...patch } : i
        ),
      }));
      get().processQueue();
    };

    /** Guarded status patch (no-op for a stale/removed attempt). */
    const patchIfCurrent = (partial: Partial<UploadItem>) => {
      if (!isCurrentAttempt(id, attempt)) return;
      patchItem(id, partial);
    };

    if (typeof eventId !== "number") {
      // No client-side eventId available (event not loaded yet). The recovery
      // bootstrap in the page gates on the event being loaded before calling
      // recoverInterrupted precisely so auto-resume never lands here; this
      // branch remains a safe, honest fallback for the rare case the event is
      // momentarily unavailable. Surface a clean, user-facing error rather than
      // proceeding with an invalid path.
      const message =
        "No se pudo determinar el evento. Recarga e inténtalo de nuevo.";
      if (isCurrentAttempt(id, attempt)) {
        void uploadQueue.patch(id, { status: "failed", error: message });
      }
      release("failed", { error: message });
      return;
    }

    // The metadata record was already persisted at enqueue time (see
    // persistEnqueuePayload) for EVERY item — including those that waited behind
    // the concurrency cap — so we do NOT re-put here (a re-put could race with
    // and clobber an enqueue-time thumbnail patch). We only patch status
    // transitions below. All queue writes are FIRE-AND-FORGET: persistence is
    // best-effort and MUST NOT block/stall the actual upload (Req 11.6).

    // Preprocess happens INSIDE uploadToBlob (images only); reflect the
    // 'processing' phase in both the store (sync) and the queue (fire-and-forget).
    patchIfCurrent({ status: "processing" });
    void uploadQueue.patch(id, { status: "processing" });

    // Move to 'uploading' for the direct-to-Blob transfer.
    patchIfCurrent({ status: "uploading", progress: 0 });
    void uploadQueue.patch(id, { status: "uploading" });

    // Read the signal off THIS attempt's controller. If the attempt was already
    // superseded/invalidated, bail before starting the network transfer.
    if (!isCurrentAttempt(id, attempt)) return;
    const signal = get().items.find((i) => i.id === id)?.abort?.signal;

    let result: BlobUploadResult;
    try {
      result = await uploadToBlob({
        file: startItemSnapshot.file,
        uploadId: id,
        eventSlug,
        eventId,
        // Thread the item's enqueue-time date (Req 6.6) into the handshake
        // clientPayload so the server can carry it in the signed tokenPayload
        // and reconstruct media.date during onUploadCompleted reconciliation
        // without fabricating a date. Same immutable value used by the
        // same-session confirm below and by confirm-only recovery.
        date: startItemSnapshot.date,
        onProgress: (pct) => setProgress(id, attempt, pct),
        signal,
      });
    } catch (error) {
      // If this attempt is no longer current (retried/canceled/dismissed), the
      // rejection belongs to a superseded attempt: no-op entirely so it cannot
      // clobber the newer attempt or a removed item.
      if (!isCurrentAttempt(id, attempt)) return;

      // Distinguish cancellation from a genuine failure. `cancelItem` aborts
      // this attempt's controller (and bumps the token, but for a non-in-flight
      // path); a genuine cancel of the in-flight upload rejects here with an
      // AbortError while the token is still current only when the abort raced
      // ahead of the token bump — treat an aborted signal / AbortError as a
      // CANCEL, never a failure (Req 10.6).
      if (signal?.aborted || isAbortError(error)) {
        // Cancellation MUST NOT become success and MUST NOT confirm/create a
        // row. Remove the persisted intent so Task 9.4 recovery never treats a
        // canceled upload as recoverable. Fire-and-forget (never block the UI).
        void uploadQueue.remove(id);
        release("canceled", {});
        return;
      }
      const message = errorMessage(error);
      void uploadQueue.patch(id, { status: "failed", error: message });
      release("failed", { error: message });
      return;
    }

    // Blob upload resolved. If this attempt was canceled/dismissed/retried
    // while the upload was finishing, the late resolve MUST NOT confirm, append
    // media, or flip status: no-op. A cancel/dismiss already removed/aborted the
    // record; do not resurrect it.
    if (!isCurrentAttempt(id, attempt)) return;

    // Persist the blobUrl + actual processed size + client BlurHash so a later
    // confirm-only recovery (Task 9.4) has what it needs, INCLUDING the BlurHash
    // (Change 2 pt4) so the recovery confirm body sends the same placeholder the
    // same-session confirm would have. NOT completed yet.
    patchIfCurrent({
      processedSize: result.processedSize,
      contentType: result.contentType,
      blurhash: result.blurhash,
    });
    // Fire-and-forget: persisting the blobUrl for recovery must not block the
    // confirm step (Req 11.6).
    void uploadQueue.patch(id, {
      status: "uploading",
      blobUrl: result.blobUrl,
      processedSize: result.processedSize,
      contentType: result.contentType,
      blurhash: result.blurhash,
    });

    // Confirm => DB row. ONLY confirm success (200/201) marks the item complete
    // (single confirm-gated success path; Req 20). A resolved Blob upload alone
    // never sets success.
    let media: Media;
    try {
      // Use the item's captured enqueue-time date (Req 6.6, 14.10) — the SAME
      // value persisted in the queue record and used by confirm-only recovery,
      // NOT a fresh confirm-time timestamp.
      media = await confirmUpload(eventSlug, result, startItemSnapshot.date);
    } catch (error) {
      // If canceled/dismissed/retried during confirm, the outcome of THIS
      // attempt is irrelevant: no-op (do not persist failure over a newer
      // attempt or a removed item).
      if (!isCurrentAttempt(id, attempt)) return;
      // Blob succeeded but confirm failed: keep 'failed', keep the persisted
      // record (with blobUrl already persisted above) so confirm-only recovery
      // is possible; the SAME uploadId is preserved (never regenerated).
      const message = errorMessage(error);
      void uploadQueue.patch(id, { status: "failed", error: message });
      release("failed", { error: message });
      return;
    }

    // Confirm succeeded. Guard once more: a confirm response arriving after
    // cancellation/dismissal MUST NOT append media or set success. Because
    // cancel/dismiss bump the token, this attempt is no longer current and we
    // no-op (the media row created server-side is safely deduped by uploadId).
    if (!isCurrentAttempt(id, attempt)) return;

    appendMediaToEventStore(media);
    // Fire-and-forget cleanup (removes record + persisted bytes); must not block
    // marking the item successful in the UI (Req 11.6).
    void uploadQueue.remove(id);
    release("success", { progress: 100, mediaResult: media, error: null });
  };

  /**
   * Start (or restart) processing an item under the concurrency cap: bump the
   * attempt token (invalidating any prior in-flight continuation for this id),
   * mark it `uploading`, attach a FRESH AbortController, and count exactly one
   * slot. Callers MUST ensure a slot is available (processQueue guarantees the
   * cap). `retryCount` is bumped only when `isRetry` is set.
   */
  const startItem = (id: string, eventSlug: string, isRetry: boolean) => {
    const controller = new AbortController();
    let nextAttempt = 0;
    set((state) => ({
      activeCount: state.activeCount + 1,
      items: state.items.map((i) => {
        if (i.id !== id) return i;
        nextAttempt = i.attempt + 1;
        return {
          ...i,
          status: "uploading" as const,
          progress: 0,
          error: null,
          abort: controller,
          attempt: nextAttempt,
          retryCount: isRetry ? i.retryCount + 1 : i.retryCount,
        };
      }),
    }));
    // Fire-and-forget; processOne manages its own slot release + queue pump,
    // guarded by the captured attempt token.
    void processOne(id, nextAttempt, eventSlug);
  };

  return {
    items: [],
    activeCount: 0,
    recoveryNotice: false,

    dismissRecoveryNotice: () => set({ recoveryNotice: false }),

    enqueueFiles: (files: File[], _eventSlug: string) => {
      if (files.length === 0) return;

      // IDENTITY RECONCILIATION (fixes client/server auth drift). The server
      // attributes every upload to whoever the httpOnly `auth_token` cookie
      // identifies (upload-token handshake + confirm both use verifyRequest).
      // The client auth store, however, is only populated once at app start and
      // on explicit login/register, so it can go stale relative to the cookie
      // (e.g. after using a second account in the same browser). When it does,
      // uploads are saved under the cookie's user while the UI filters "Mis
      // Fotos" by the stale store user — so freshly uploaded media never shows.
      //
      // Re-sync the auth store from the cookie (via GET /api/me) at enqueue time
      // so the client's notion of "me" matches the account the upload will be
      // attributed to. Fire-and-forget: enqueue/queue mechanics stay synchronous
      // and the event-store "Mis Fotos" filter re-renders reactively once the
      // auth store settles. On failure loadUser clears the session, which the
      // layout/page already handle.
      void useAuthStore.getState().loadUser();

      const newItems: UploadItem[] = files.map((file) => ({
        id: crypto.randomUUID(), // one uploadId per item, reused everywhere
        file,
        previewUrl: URL.createObjectURL(file),
        status: "queued" as const,
        progress: 0,
        originalSize: file.size,
        processedSize: null,
        contentType: file.type,
        retryCount: 0,
        error: null,
        abort: null,
        mediaResult: null,
        blurhash: null,
        thumbnailDataUrl: null,
        recovery: null,
        // Capture the enqueue-time upload-intent date EXACTLY ONCE per item
        // (Req 6.4/6.6). This one value is persisted in the queue record, sent
        // by the same-session confirm, and reused by confirm-only recovery — so
        // enqueue, persisted record, same-session confirm, and recovery confirm
        // all use ONE identical date. Retry reuses this item (same date); it is
        // never recomputed.
        date: new Date().toISOString(),
        attempt: 0,
      }));

      set((state) => ({ items: [...state.items, ...newItems] }));

      // Switch global state to 'myPhotos' (unchanged behavior).
      useGlobalStore.getState().changeState("myPhotos");

      // BYTE-PERSISTENCE POLICY (Change 3a) — best-effort, per item, at enqueue:
      //   * image AND size <= RESUMABLE_MAX_BYTES -> persist the actual bytes so
      //     a mid-upload reload can transparently auto-resume the same uploadId.
      //   * video OR oversized image -> do NOT persist bytes; persist only a
      //     small preview thumbnail so recovery can show it + a dismissable
      //     warning.
      // All persistence is fire-and-forget and swallow-safe: IndexedDB/canvas
      // failures never block enqueue or the upload itself (Req 11.6). The queue
      // metadata record is written by processOne's `uploadQueue.put(toRecord…)`
      // which already carries kind/hasBytes/oversized/thumbnailDataUrl.
      for (const item of newItems) {
        void persistEnqueuePayload(item, _eventSlug);
      }

      get().processQueue();
    },

    processQueue: () => {
      const { items, activeCount } = get();
      const queuedItems = items.filter((item) => item.status === "queued");
      const slotsAvailable = MAX_CONCURRENT - activeCount;

      if (slotsAvailable <= 0 || queuedItems.length === 0) return;

      // OFFLINE: do not start uploads that would immediately fail (and burn
      // retries). Leave items 'queued' + persisted in IndexedDB; a 'online'
      // listener (registered once, below) re-pumps the queue when connectivity
      // returns. This is how uploads are "queued even if offline".
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        return;
      }

      const eventSlug = getEventSlug();
      // Only fill the exact number of free slots. Because startItem is the sole
      // place activeCount is incremented and it only runs for a `queued` item
      // (immediately flipped to `uploading`), an item can never occupy more than
      // one slot even if processQueue is called multiple times concurrently.
      const itemsToProcess = queuedItems.slice(0, slotsAvailable);
      for (const item of itemsToProcess) {
        startItem(item.id, eventSlug, false);
      }
    },

    retryItem: (id: string) => {
      const item = get().items.find((i) => i.id === id);
      if (!item) return;

      // Retry ONLY applies to a genuinely retryable terminal state. Ignore a
      // retry while the item is queued/processing/uploading/success/canceled so
      // it can never double-start or occupy a second slot.
      if (!RETRYABLE_STATUSES.has(item.status)) return;

      if (item.retryCount >= MAX_RETRIES) {
        // Surface the retry cap without starting another attempt or a slot.
        if (item.status !== "exhausted") patchItem(id, { status: "exhausted" });
        return;
      }

      // Respect the concurrency cap: if no slot is free, re-queue the item and
      // let processQueue pick it up under the cap (same slot accounting as a
      // normal upload). This bumps the attempt token via startItem when it runs,
      // and uses a FRESH AbortController (never the previous, aborted one).
      if (get().activeCount >= MAX_CONCURRENT) {
        // Bump attempt now so any still-finishing prior continuation is
        // invalidated immediately, and reset for a clean re-queue.
        set((state) => ({
          items: state.items.map((i) =>
            i.id === id
              ? {
                  ...i,
                  status: "queued" as const,
                  progress: 0,
                  error: null,
                  abort: null,
                  attempt: i.attempt + 1,
                  retryCount: i.retryCount + 1,
                }
              : i
          ),
        }));
        return;
      }

      // A slot is free: start immediately with a fresh AbortController and a
      // bumped attempt token, reusing the SAME uploadId (item.id) — never a new
      // one — and going through the same slot accounting as a normal upload.
      startItem(id, getEventSlug(), true);
    },

    retryConfirm: (id: string) => {
      const item = get().items.find((i) => i.id === id);
      if (!item) return;
      // Only for surfaced 'confirm-retry' recovery items (Blob exists, confirm
      // previously failed). Ignore otherwise so it never double-acts.
      if (item.recovery !== "confirm-retry") return;

      const eventSlug = getEventSlug();

      // Re-run ONLY the idempotent confirm (no Blob re-upload), reusing the SAME
      // uploadId so a duplicate row can never be created (dedupe by upload_id).
      // The blobUrl/metadata live in the persisted queue record; read it back
      // (rare user action) rather than duplicating it on the item.
      void (async () => {
        const records = await uploadQueue.all();
        const r = records.find((rec) => rec.uploadId === id);
        if (!r || typeof r.blobUrl !== "string" || r.blobUrl.length === 0) {
          // Nothing to confirm against — surface a clear message, keep the item.
          patchItem(id, {
            error:
              "No se encontró la subida para reintentar. Tócala para descartar.",
            recovery: "inert",
            status: "exhausted",
          });
          return;
        }

        const confirmBody: ConfirmBody = {
          uploadId: r.uploadId,
          blobUrl: r.blobUrl,
          filename: r.filename,
          contentType: r.contentType,
          originalSize: r.originalSize,
          processedSize:
            typeof r.processedSize === "number" && r.processedSize > 0
              ? r.processedSize
              : r.originalSize,
          date: typeof r.date === "string" ? r.date : item.date,
        };
        if (typeof r.blurhash === "string" && r.blurhash.length > 0) {
          confirmBody.blurhash = r.blurhash;
        }

        try {
          const media = await postConfirm(eventSlug, confirmBody);
          appendMediaToEventStore(media);
          await uploadQueue.remove(id); // removes record + bytes
          // Remove the surfaced recovery item; the Media is now in the gallery.
          set((state) => ({ items: state.items.filter((i) => i.id !== id) }));
        } catch (error) {
          // Keep the item surfaced with the fresh error; it stays retryable.
          patchItem(id, {
            error: errorMessage(error),
            recovery: "confirm-retry",
            status: "failed",
          });
        }
      })();
    },

    cancelItem: (id: string) => {
      const item = get().items.find((i) => i.id === id);
      if (!item) return;

      // Already-confirmed uploads are immutable: cancel is a NO-OP (do not
      // delete the media row or Blob, do not turn success into canceled).
      if (item.status === "success") return;

      // Already terminal in a canceled state: nothing to do.
      if (item.status === "canceled") return;

      if (item.abort) {
        // In-flight/active: bump the attempt token FIRST so any late resolve of
        // the current attempt (upload or confirm finishing) no-ops and cannot
        // flip the item back to uploading/success/failed, then abort the
        // in-flight controller. Finalize as 'canceled' here and remove the queue
        // record so Task 9.4 recovery never treats it as recoverable. Because
        // the token is now bumped, the aborted attempt's own catch/finally
        // no-ops and will NOT double-release the slot — so we release it here.
        item.abort.abort();
        set((state) => ({
          activeCount: Math.max(0, state.activeCount - 1),
          items: state.items.map((i) =>
            i.id === id
              ? {
                  ...i,
                  status: "canceled" as const,
                  abort: null,
                  attempt: i.attempt + 1,
                }
              : i
          ),
        }));
        void uploadQueue.remove(id);
        get().processQueue();
        return;
      }

      // Queued (not yet started) or otherwise not in-flight: it must NOT start
      // uploading and must NOT call Blob/confirm. Bump the token, mark canceled
      // (so processQueue never picks it up — it filters on `queued`), free the
      // object URL, and remove the queue record.
      URL.revokeObjectURL(item.previewUrl);
      void uploadQueue.remove(id);
      set((state) => ({
        items: state.items.map((i) =>
          i.id === id
            ? { ...i, status: "canceled" as const, abort: null, attempt: i.attempt + 1 }
            : i
        ),
      }));
    },

    dismissItem: (id: string) => {
      const item = get().items.find((i) => i.id === id);
      if (!item) return;

      // Bump the attempt token FIRST and abort any in-flight controller so a
      // dismissed active upload's async continuation (upload/confirm finishing)
      // no-ops: it can no longer call confirm, append media, or resurrect the
      // removed UI item. If the dismissed item was in-flight, release its slot
      // here (the invalidated attempt will not release it) so activeCount stays
      // correct.
      const wasActive = item.abort != null;
      if (item.abort) item.abort.abort();
      URL.revokeObjectURL(item.previewUrl);
      void uploadQueue.remove(id);
      set((state) => ({
        activeCount: wasActive
          ? Math.max(0, state.activeCount - 1)
          : state.activeCount,
        items: state.items.filter((i) => i.id !== id),
      }));
      if (wasActive) get().processQueue();
    },

    // -------------------------------------------------------------------------
    // recoverInterrupted (Task 9.4) — cross-reload recovery ONLY.
    //
    // THREE DISTINCT SCENARIOS (kept deliberately distinct — never merged into a
    // generic "resume"):
    //
    //   A) Multipart part retry WITHIN one live upload() session — owned by the
    //      Vercel Blob SDK (multipart:true). NOT handled here and nothing to do
    //      here: it lives entirely inside a single in-memory upload() call.
    //
    //   B) upload() failed in the SAME session (original File still in memory) —
    //      this is the existing retry path (`retryItem`): a fresh upload()
    //      reusing the SAME uploadId + a fresh AbortController under the attempt
    //      guard and MAX_CONCURRENT cap. `recoverInterrupted` does NOT touch
    //      in-memory items; Scenario B is driven by the user via retryItem.
    //
    //   C) Browser refresh / tab close / process restart — the in-memory session
    //      (including the original File bytes) is GONE. Only IndexedDB metadata
    //      survives (NEVER bytes). This is what this function handles, per
    //      persisted record:
    //        * status 'completed'  -> already succeeded: remove the record
    //                                 (Req 14.7). Nothing surfaced.
    //        * has blobUrl & a persisted `date` & status != completed ->
    //                                 CONFIRM-ONLY recovery (Req 14.4/14.10): the
    //                                 Blob already exists, so the correct action
    //                                 is an idempotent-by-uploadId confirm — NOT a
    //                                 re-upload. The ConfirmUploadBody is rebuilt
    //                                 from the persisted metadata + the persisted
    //                                 enqueue-time `date` (never fabricated/now,
    //                                 never `updatedAt`). The SAME uploadId is
    //                                 reused. On success the returned Media is
    //                                 appended to the event store and the queue
    //                                 record removed; on failure (Blob missing,
    //                                 4xx/409, network) the record is KEPT and
    //                                 surfaced so it can be retried — never
    //                                 silently dropped, never marked success by
    //                                 the Blob alone.
    //        * has blobUrl but NO persisted `date` (legacy record predating the
    //                                 `date` field) -> Req 14.11: do NOT
    //                                 auto-confirm and do NOT fabricate a date.
    //                                 Surface the record honestly and KEEP it.
    //        * no blobUrl -> the original File bytes are gone after reload; there
    //                                 is no resumable byte stream to restart
    //                                 (design D4). Surface the record so the user
    //                                 knows the file must be reselected/uploaded
    //                                 again. Do NOT auto-mint a new uploadId (the
    //                                 persisted uploadId is preserved on the
    //                                 surfaced item so a later reselect reuses it);
    //                                 do NOT fabricate a restart with empty bytes.
    //
    // HONESTY (D4): nothing here claims a Blob multipart byte stream can resume
    // across a reload — it cannot. Recovery is either (a) confirm an
    // already-existing Blob idempotently by uploadId using the persisted
    // enqueue-time date (no re-upload) or (b) reselect the original File for a
    // fresh upload reusing the uploadId.
    //
    // NO AUTO-RESUME / NO SILENT RE-UPLOAD (Req 14.8): confirm-only recovery
    // performs ONLY the idempotent confirm (never a Blob re-upload). Records that
    // cannot be auto-confirmed (no blobUrl, or a legacy record with no persisted
    // date per Req 14.11) are surfaced as inert items — no network I/O until the
    // user acts — marked with a terminal, user-facing status ('exhausted')
    // carrying an explanatory `error` message and retryCount = MAX_RETRIES so the
    // placeholder UI's tap handler treats them as dismiss-only (it will never
    // auto-start an upload of the absent bytes).
    //
    // STALE-ASYNC / CONCURRENCY: this function starts NO upload and occupies NO
    // concurrency slot (it only reads the queue and appends inert items), so it
    // introduces no second concurrency manager and cannot race the attempt guard.
    // If the user later acts on a surfaced item, it flows through the SAME
    // attempt-guarded startItem/processQueue machinery (subject to
    // MAX_CONCURRENT).
    //
    // RUN-ONCE / SSR / STRICT-MODE: guarded by the module-level `recoveryHasRun`
    // flag so it runs at most once per page load regardless of Strict-Mode
    // double-invoke or re-renders. It touches no browser global at module scope;
    // uploadQueue.all() is best-effort (resolves [] when IndexedDB is
    // unavailable) so recovery simply finds nothing and never throws.
    recoverInterrupted: async (eventSlug: string) => {
      // Run-once guard (Strict Mode double-invoke + re-render safe).
      if (recoveryHasRun) return;
      recoveryHasRun = true;

      // Best-effort read of persisted intent. Never rejects (Req 11.6): returns
      // [] when IndexedDB is unavailable, so recovery is a safe no-op there.
      const records = await uploadQueue.all();
      if (records.length === 0) return;

      const existingIds = new Set(get().items.map((i) => i.id));
      const toSurface: UploadItem[] = [];
      // Records eligible for confirm-only recovery (blobUrl + persisted date).
      // Collected here and processed AFTER the classification loop in a bounded
      // sequential loop (no unbounded parallel confirms; no second concurrency
      // manager). Confirm-only calls start NO Blob upload and occupy NO upload
      // slot — they only rebuild the confirm body and POST it.
      const toConfirm: QueueRecord[] = [];
      // Records eligible for TRANSPARENT AUTO-RESUME (Change 3): no blobUrl but
      // the actual bytes were persisted (resumable image). Each becomes a
      // 'queued' UploadItem carrying its bytes-backed File and is driven through
      // the SAME attempt-guarded startItem/processQueue machinery (subject to
      // MAX_CONCURRENT) reusing the SAME uploadId — no reselect, no new id.
      const toResume: UploadItem[] = [];

      for (const r of records) {
        // Only recover records that belong to the event currently being viewed;
        // leave records for other events untouched for their own recovery pass.
        if (r.eventSlug !== eventSlug) continue;

        // Never resurrect an item already present in memory (e.g. a same-session
        // item mid-flight): the live attempt owns it, not recovery.
        if (existingIds.has(r.uploadId)) continue;

        // 'completed' -> already succeeded: remove record + bytes and never
        // surface (Req 14.7). remove() cleans both stores.
        if (r.status === "completed") {
          void uploadQueue.remove(r.uploadId);
          continue;
        }

        const hasBlob = typeof r.blobUrl === "string" && r.blobUrl.length > 0;
        // Defensive read of the enqueue-time date: a legacy record written
        // before the `date` field existed may lack it at runtime even though the
        // type declares it. Treat missing/empty as "no persisted date" (Req
        // 14.11) — never fabricate one.
        const hasDate = typeof r.date === "string" && r.date.length > 0;

        // (1) HAS BLOB (image or video): the Blob already exists, so the correct
        //     action is an idempotent-by-uploadId confirm — NOT a re-upload.
        //     Auto-confirm silently; on success append + remove; on failure
        //     surface a preview + tap-to-retry item (handled in the loop below).
        //     A legacy record with a blobUrl but no persisted date (Req 14.11)
        //     is NOT auto-confirmed — it falls through to be surfaced inertly.
        if (hasBlob && hasDate) {
          toConfirm.push(r);
          continue;
        }

        // (2) NO BLOB, resumable image WITH persisted bytes -> transparent
        //     auto-resume. Load the bytes and rebuild a 'queued' item reusing the
        //     SAME uploadId; it is started by processQueue under MAX_CONCURRENT.
        const isResumableImage =
          !hasBlob &&
          r.hasBytes === true &&
          (r.kind === "image" || isImageMime(r.contentType));
        if (isResumableImage) {
          const bytes = await uploadQueue.getBytes(r.uploadId);
          if (bytes) {
            const resumedFile = new File([bytes], r.filename, {
              type: r.contentType,
            });
            toResume.push({
              id: r.uploadId, // SAME uploadId — never minted anew
              file: resumedFile,
              previewUrl: URL.createObjectURL(resumedFile),
              status: "queued",
              progress: 0,
              originalSize: r.originalSize,
              processedSize: r.processedSize,
              contentType: r.contentType,
              retryCount: 0,
              error: null,
              abort: null,
              mediaResult: null,
              blurhash: typeof r.blurhash === "string" ? r.blurhash : null,
              thumbnailDataUrl: null,
              recovery: null,
              date: typeof r.date === "string" ? r.date : new Date().toISOString(),
              attempt: 0,
            });
            continue;
          }
          // Bytes unexpectedly missing (IndexedDB unavailable / evicted): fall
          // through to surface it inertly rather than silently dropping it.
        }

        // (3) NO BLOB, video OR oversized image (no bytes) OR legacy blob record
        //     with no date -> surface an INERT item. It shows the persisted
        //     thumbnail (if any) plus a dismissable warning; no auto-action.
        //     confirm-retry is used ONLY for a has-blob record (kept but failed
        //     to auto-confirm here means "no date"); otherwise it is dismiss-only.
        const placeholderFile = new File([], r.filename, {
          type: r.contentType,
        });
        const recoveryKind: "confirm-retry" | "inert" = hasBlob
          ? "confirm-retry"
          : "inert";
        const message = hasBlob
          ? "La subida se completó pero no se pudo finalizar. Tócala para reintentar."
          : "Este archivo no se subió. Tócalo para descartar.";

        toSurface.push(
          buildRecoverySurfaceItem(r, placeholderFile, message, recoveryKind)
        );
      }

      // Append inert/confirm-retry surfaced items first. These perform NO upload
      // and occupy NO concurrency slot (processQueue only picks up 'queued').
      if (toSurface.length > 0) {
        // Raise the recovery notice if ANY surfaced item is INERT — i.e. a video
        // or an oversized image whose bytes were not persisted and therefore
        // cannot be auto-resumed. The page shows a Spanish popup telling the user
        // to re-upload these manually.
        const hasInert = toSurface.some((i) => i.recovery === "inert");
        set((state) => ({
          items: [...state.items, ...toSurface],
          recoveryNotice: state.recoveryNotice || hasInert,
        }));
      }

      // Append the auto-resume items (status 'queued', bytes-backed File) and
      // drive them through the SAME machinery under MAX_CONCURRENT. No second
      // concurrency manager; startItem's attempt guard governs each.
      if (toResume.length > 0) {
        set((state) => ({ items: [...state.items, ...toResume] }));
      }

      // Make the surfaced/recovered items visible in the same view the user uses
      // for their own uploads (unchanged behavior vs enqueueFiles).
      if (toSurface.length > 0 || toConfirm.length > 0 || toResume.length > 0) {
        useGlobalStore.getState().changeState("myPhotos");
      }

      // Kick off auto-resume through the normal concurrency-capped pump.
      if (toResume.length > 0) {
        get().processQueue();
      }

      // CONFIRM-ONLY recovery pass (Req 14.4/14.6/14.10). Bounded/sequential —
      // never fire unbounded parallel confirms. Each iteration:
      //   * rebuilds the ConfirmUploadBody from persisted metadata + persisted
      //     enqueue-time date (never fabricated/now, never updatedAt),
      //   * reuses the SAME uploadId,
      //   * calls the idempotent Confirm_Endpoint (no re-upload of the Blob).
      // On success: append the Media to the event store + remove the record. On
      // failure: KEEP the record and surface it inertly so it can be retried.
      for (const r of toConfirm) {
        // Skip any record that has since appeared in memory (e.g. a same-session
        // item), so recovery never fights a live attempt.
        if (get().items.some((i) => i.id === r.uploadId)) continue;

        const confirmBody: ConfirmBody = {
          uploadId: r.uploadId,
          blobUrl: r.blobUrl as string,
          filename: r.filename,
          contentType: r.contentType,
          originalSize: r.originalSize,
          // The Confirm_Endpoint requires a positive processedSize. For a
          // non-preprocessed file the uploaded bytes equal originalSize, which
          // matches the live path (processedSize is set from the upload result,
          // and equals originalSize when no preprocessing occurred). Use
          // originalSize as the fallback when processedSize was not persisted.
          processedSize:
            typeof r.processedSize === "number" && r.processedSize > 0
              ? r.processedSize
              : r.originalSize,
          // Persisted enqueue-time date — the whole point of confirm-only
          // recovery (Req 14.10). Never fabricated; never updatedAt.
          date: r.date,
        };
        // Carry the persisted client BlurHash so the recovered media renders
        // its placeholder immediately, matching the same-session confirm.
        if (typeof r.blurhash === "string" && r.blurhash.length > 0) {
          confirmBody.blurhash = r.blurhash;
        }

        try {
          const media = await postConfirm(eventSlug, confirmBody);
          appendMediaToEventStore(media);
          await uploadQueue.remove(r.uploadId);
        } catch (error) {
          // Confirm failed (Blob missing, 4xx/409, or network). Do NOT mark
          // success and do NOT drop the record: keep it and surface it as a
          // preview + tap-to-retry item (recovery === 'confirm-retry') so the
          // user can re-run the idempotent confirm. Reuses the persisted
          // thumbnail if present.
          const placeholderFile = new File([], r.filename, {
            type: r.contentType,
          });
          const message = errorMessage(error);
          set((state) => ({
            items: [
              ...state.items,
              buildRecoverySurfaceItem(
                r,
                placeholderFile,
                message,
                "confirm-retry"
              ),
            ],
          }));
        }
      }
    },
  };
});

/** The exact JSON body shape the Confirm_Endpoint accepts (design Component 3). */
interface ConfirmBody {
  uploadId: string;
  blobUrl: string;
  filename: string;
  contentType: string;
  originalSize: number;
  processedSize: number;
  date: string;
  blurhash?: string;
}

/**
 * Call the confirm endpoint and return the created/existing Media row. Builds
 * ConfirmUploadBody from the ACTUAL BlobUploadResult. `date` MUST be the item's
 * enqueue-time upload-intent date (Req 6.6, 14.10) — the SAME value that is
 * persisted in the queue record and reused by confirm-only recovery — NOT a
 * freshly computed confirm-time timestamp. `blurhash` is only sent when the
 * result actually carries one (never invented).
 */
async function confirmUpload(
  eventSlug: string,
  result: BlobUploadResult,
  date: string
): Promise<Media> {
  const body: ConfirmBody = {
    uploadId: result.uploadId,
    blobUrl: result.blobUrl,
    filename: result.filename,
    contentType: result.contentType,
    originalSize: result.originalSize,
    processedSize: result.processedSize,
    // Enqueue-time date threaded from the item (identical across enqueue,
    // persisted record, same-session confirm, and recovery confirm).
    date,
  };
  if (result.blurhash != null) {
    body.blurhash = result.blurhash;
  }

  return postConfirm(eventSlug, body);
}

/**
 * POST a fully-built confirm body to the Confirm_Endpoint and return the
 * created/existing Media row. Shared by same-session confirm and confirm-only
 * recovery so both use the identical request path and error mapping. The
 * endpoint is idempotent by `uploadId` (200 existing / 201 created).
 */
async function postConfirm(
  eventSlug: string,
  body: ConfirmBody
): Promise<Media> {
  const response = await fetch(
    `/api/event/${eventSlug}/media/confirm`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    // Surface a clean, user-facing message without leaking server internals.
    throw new Error(confirmErrorMessage(response.status));
  }

  return (await response.json()) as Media;
}

/** Map a confirm HTTP status to a safe, user-facing message. */
function confirmErrorMessage(status: number): string {
  if (status === 401) return "Tu sesión ha expirado. Vuelve a iniciar sesión.";
  if (status === 403) return "No tienes permiso para subir a este evento.";
  return "No se pudo guardar el archivo. Inténtalo de nuevo.";
}

/** True when an error represents an aborted (canceled) operation. */
function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === "AbortError"
  ) ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error as { name?: unknown }).name === "AbortError");
}

/** Extract a safe error message from an unknown thrown value. */
function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Error al subir el archivo.";
}

/**
 * Helper to get the current event slug from the URL pathname.
 * The event page URL is structured as /[event-slug].
 */
function getEventSlug(): string {
  if (typeof window === "undefined") return "";
  const pathSegments = window.location.pathname.split("/").filter(Boolean);
  return pathSegments[0] || "";
}

// OFFLINE RESUME: when connectivity returns, re-pump the queue so any items that
// were left 'queued' while offline (processQueue no-ops offline) start
// uploading. Registered once at module load (client-only, guarded). This is not
// a second concurrency manager — it just calls the existing processQueue, which
// enforces MAX_CONCURRENT.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("online", () => {
    useUploadStore.getState().processQueue();
  });
}

export default useUploadStore;
