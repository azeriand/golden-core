"use client";

import Image from "next/image";
import useUploadStore from "@/app/src/stores/upload.store";

export interface MediaItemPlaceholderProps {
  id: string;
  onRetry: (id: string) => void;
  onRetryConfirm: (id: string) => void;
  onDismiss: (id: string) => void;
}

export default function MediaItemPlaceholder({
  id,
  onRetry,
  onRetryConfirm,
  onDismiss,
}: MediaItemPlaceholderProps) {
  // Select ONLY this component's own item by id. Zustand's default equality is
  // Object.is on the selector result; the store's `set` calls map items
  // immutably (`items.map(i => i.id === target ? {...i, ...} : i)`), so an
  // update to another item returns the SAME object reference for this item and
  // this selector's result is unchanged — this placeholder does NOT re-render
  // when a different upload's progress changes. It re-renders only when THIS
  // item's object reference changes (i.e. this item actually updated). This
  // preserves the per-item subscription contract (Req 10.9).
  const item = useUploadStore((state) => state.items.find((i) => i.id === id));

  // The item may be undefined if it was just removed/dismissed while masonry's
  // id list is mid-update; render nothing so a stale id can't crash.
  if (!item) return null;

  const isImage = item.file.type.startsWith("image/");
  // Queued: enqueued but waiting for a free concurrency slot (upload not started
  // yet). It must NOT look already-uploaded — show it blurred with an
  // indeterminate spinner (there is no real progress to show yet).
  const isQueued = item.status === "queued";
  const isUploading = item.status === "uploading" || item.status === "processing";
  const isFailed = item.status === "failed";
  const isExhausted = item.status === "exhausted";
  const isSuccess = item.status === "success";

  // Blur the preview for any not-yet-completed active state (queued, processing,
  // uploading) so pending items never look like finished uploads.
  const isPending = isQueued || isUploading;

  // Recovery classification (Change 3d) — distinct from status:
  //  - 'confirm-retry': Blob exists but confirm failed -> preview + tap-to-retry
  //    (re-runs confirm only, never a re-upload).
  //  - 'inert': video/oversized image with no bytes -> thumbnail + tap-to-dismiss.
  const isConfirmRetry = item.recovery === "confirm-retry";
  const isInert = item.recovery === "inert";

  const handleTap = () => {
    if (isConfirmRetry) {
      // Preview + tap-to-retry: re-run the idempotent confirm (Change 3d).
      onRetryConfirm(item.id);
      return;
    }
    if (isInert) {
      // Thumbnail + dismissable warning: tap discards the surfaced item.
      onDismiss(item.id);
      return;
    }
    // Live (non-recovery) items keep the original behavior.
    if (isFailed && item.retryCount < 3) {
      onRetry(item.id);
    } else if (isExhausted) {
      onDismiss(item.id);
    }
  };

  // Media source resolution:
  //  - success -> the final Blob URL,
  //  - a surfaced recovery item with a persisted thumbnail (video/oversized) ->
  //    the thumbnail data URL,
  //  - otherwise the local preview object URL (live upload / bytes-backed
  //    auto-resume both have a real previewUrl).
  const hasThumbnail =
    (isConfirmRetry || isInert) &&
    typeof item.thumbnailDataUrl === "string" &&
    item.thumbnailDataUrl.length > 0;

  const mediaSrc =
    isSuccess && item.mediaResult
      ? item.mediaResult.content
      : hasThumbnail
        ? (item.thumbnailDataUrl as string)
        : item.previewUrl;

  // Whether to render the source as an <img>. A persisted thumbnail is ALWAYS a
  // JPEG image (even for a video's poster frame), so render it as an image. For
  // an inert video WITHOUT a thumbnail there is no preview at all -> generic
  // placeholder box.
  const isVideoContent = isSuccess && item.mediaResult
    ? item.mediaResult.type?.startsWith("video/")
    : item.file.type.startsWith("video/");

  const showAsImage = hasThumbnail || (isSuccess && item.mediaResult ? !isVideoContent : isImage);

  // A surfaced inert item with NO preview (empty bytes-less File + no thumbnail):
  // render a neutral box rather than a broken <img>/<video> src.
  const hasNoPreview =
    (isConfirmRetry || isInert) && !hasThumbnail && (mediaSrc === "" || !mediaSrc);

  // Progress ring calculations
  const radius = 20;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset =
    circumference - (item.progress / 100) * circumference;

  return (
    <article
      // A neutral background + a reserved minimum height while PENDING makes the
      // tile visible INSTANTLY (a blurred box + spinner) the moment it is
      // enqueued — before the local blob preview has decoded. Without this the
      // <article> collapsed to ~0 height until the <img> loaded, so with many
      // files at once the first tiles appeared to arrive slowly. The preview
      // image fades in on top once decoded; the reserved min-height only applies
      // while pending (a decoded/success image drives its own intrinsic height).
      className={`w-full h-auto rounded-lg relative overflow-hidden cursor-pointer${
        isPending ? " bg-neutral-200" : ""
      }`}
      style={isPending ? { minHeight: "8rem" } : undefined}
      onClick={handleTap}
    >
      {/* Media preview */}
      {hasNoPreview ? (
        // Neutral placeholder box for a bytes-less, thumbnail-less recovery item
        // (e.g. a video whose poster frame could not be captured).
        <div className="w-full rounded-lg bg-neutral-200" style={{ aspectRatio: "1 / 1" }} />
      ) : showAsImage ? (
        <Image
          src={mediaSrc}
          alt="Vista previa de subida"
          // Intrinsic responsive rendering: full container width, auto height
          // derived from the image's natural aspect ratio. This mirrors the
          // width={0}/height={0} + style pattern used in media-item.tsx and
          // preserves the previous `w-full h-auto` <img> behavior exactly.
          width={0}
          height={0}
          sizes="50vw"
          // The preview src is a LOCAL `blob:`/`data:` URL during upload or
          // recovery and a freshly-uploaded remote Blob URL on success. Neither
          // a `blob:` nor a `data:` URL can be routed through the Next image
          // optimizer, so `unoptimized` keeps the immediate local preview
          // working and avoids a broken optimizer fetch. This satisfies
          // @next/next/no-img-element without depending on remotePatterns.
          unoptimized
          // Decode off the main thread so mounting many placeholders at once
          // does not block paint of the instant blurred boxes.
          decoding="async"
          className="w-full h-auto rounded-lg"
          style={{
            width: "100%",
            height: "auto",
            filter: isPending ? "blur(10px)" : "none",
            transition: "filter 300ms ease",
          }}
        />
      ) : (
        <video
          src={mediaSrc}
          className="w-full h-auto rounded-lg"
          style={{
            filter: isPending ? "blur(10px)" : "none",
            transition: "filter 300ms ease",
          }}
          muted
          playsInline
          preload="metadata"
          {...(isSuccess ? { controls: true } : {})}
        />
      )}

      {/* Indeterminate ring - shown while QUEUED (waiting for a free slot; the
          upload has not started, so there is no real percentage yet). A partial
          arc rotates continuously (animate-spin) to read as "pending", visually
          matching the determinate progress ring below. */}
      {isQueued && (
        <div className="absolute inset-0 flex items-center justify-center">
          <svg width="56" height="56" className="animate-spin">
            {/* Track */}
            <circle
              cx="28"
              cy="28"
              r={radius}
              fill="none"
              stroke="rgba(255, 255, 255, 0.3)"
              strokeWidth="4"
            />
            {/* Rotating arc (~25% of the circumference) */}
            <circle
              cx="28"
              cy="28"
              r={radius}
              fill="none"
              stroke="white"
              strokeWidth="4"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * 0.75}
            />
          </svg>
        </div>
      )}

      {/* Progress ring overlay - shown while uploading/processing (incl. auto-resume) */}
      {isUploading && (
        <div className="absolute inset-0 flex items-center justify-center">
          <svg width="56" height="56" className="transform -rotate-90">
            {/* Background circle */}
            <circle
              cx="28"
              cy="28"
              r={radius}
              fill="none"
              stroke="rgba(255, 255, 255, 0.3)"
              strokeWidth="4"
            />
            {/* Progress circle */}
            <circle
              cx="28"
              cy="28"
              r={radius}
              fill="none"
              stroke="white"
              strokeWidth="4"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={strokeDashoffset}
            />
          </svg>
          <span className="absolute text-white text-xs font-medium">
            {item.progress}%
          </span>
        </div>
      )}

      {/* Error / recovery overlay - shown when failed, exhausted, or surfaced. */}
      {(isFailed || isExhausted || isConfirmRetry || isInert) && !isUploading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40 rounded-lg">
          <svg
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            className="text-white"
          >
            <circle
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="2"
            />
            <path
              d="M12 8v4m0 4h.01"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {/* Distinct, honest per-state instruction. */}
          {isConfirmRetry && (
            <p className="absolute bottom-2 text-white text-xs text-center px-2">
              Toca para reintentar
            </p>
          )}
          {(isInert || (isExhausted && !isConfirmRetry)) && (
            <p className="absolute bottom-2 text-white text-xs text-center px-2">
              Toca para descartar
            </p>
          )}
        </div>
      )}
    </article>
  );
}
