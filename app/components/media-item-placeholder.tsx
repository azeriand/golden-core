"use client";

import { UploadItem } from "@/app/src/stores/upload.store";

export interface MediaItemPlaceholderProps {
  item: UploadItem;
  onRetry: (id: string) => void;
  onDismiss: (id: string) => void;
}

export default function MediaItemPlaceholder({
  item,
  onRetry,
  onDismiss,
}: MediaItemPlaceholderProps) {
  const isImage = item.file.type.startsWith("image/");
  const isUploading = item.status === "uploading";
  const isFailed = item.status === "failed";
  const isExhausted = item.status === "exhausted";
  const isSuccess = item.status === "success";

  const handleTap = () => {
    if (isFailed && item.retryCount < 3) {
      onRetry(item.id);
    } else if (isExhausted) {
      onDismiss(item.id);
    }
  };

  // Determine the media source: use final blob URL on success, otherwise local preview
  const mediaSrc =
    isSuccess && item.mediaResult ? item.mediaResult.content : item.previewUrl;

  // Determine if the final content is a video (on success, check mediaResult type)
  // type is the MIME string (e.g. "video/mp4") or null (null means image)
  const showAsImage =
    isSuccess && item.mediaResult
      ? !item.mediaResult.type?.startsWith("video/")
      : isImage;

  // Progress ring calculations
  const radius = 20;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset =
    circumference - (item.progress / 100) * circumference;

  return (
    <article
      className="w-full h-auto rounded-lg relative overflow-hidden cursor-pointer"
      onClick={handleTap}
    >
      {/* Media preview */}
      {showAsImage ? (
        <img
          src={mediaSrc}
          alt="Upload preview"
          className="w-full h-auto rounded-lg"
          style={{
            filter: isUploading ? "blur(10px)" : "none",
            transition: "filter 300ms ease",
          }}
        />
      ) : (
        <video
          src={mediaSrc}
          className="w-full h-auto rounded-lg"
          style={{
            filter: isUploading ? "blur(10px)" : "none",
            transition: "filter 300ms ease",
          }}
          muted
          playsInline
          preload="metadata"
          {...(isSuccess ? { controls: true } : {})}
        />
      )}

      {/* Progress ring overlay - shown while uploading */}
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

      {/* Error icon overlay - shown when failed */}
      {(isFailed || isExhausted) && (
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
          {isExhausted && (
            <p className="absolute bottom-2 text-white text-xs text-center px-2">
              Tap to dismiss
            </p>
          )}
        </div>
      )}
    </article>
  );
}
