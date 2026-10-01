"use client";

import { useState } from "react";
import Image from "next/image";
import { AdminMedia } from "../../dto/admin-media";
import ReasonDialog from "./ReasonDialog";
import ModerationHistory from "./ModerationHistory";

interface MediaItemCardProps {
    media: AdminMedia;
    /**
     * Called when the admin toggles visibility. The component handles the
     * ReasonDialog flow internally; the parent only needs to persist the change.
     * @param mediaId  - ID of the affected media item
     * @param hidden   - New desired visibility state
     * @param reason   - Optional moderation reason (hide actions only)
     */
    onVisibilityToggle: (
        mediaId: number,
        hidden: boolean,
        reason?: string
    ) => Promise<void>;
}

/**
 * Card used in the admin media management view. Shows a thumbnail (image or
 * video poster), a hidden-state badge on the top-left, and action buttons:
 *
 * - Hide   – opens ReasonDialog to capture an optional reason, then calls
 *            onVisibilityToggle(id, true, reason)
 * - Unhide – toggles directly (no dialog), calls onVisibilityToggle(id, false)
 * - History – opens ModerationHistory modal
 *
 * Hidden items render with reduced opacity and a tinted overlay so admins can
 * instantly distinguish them from visible items (Req 2.2).
 *
 * Satisfies Requirements 1.1, 1.2, 1.3, 2.1, 2.2, 5.1.
 */
export default function MediaItemCard({ media, onVisibilityToggle }: MediaItemCardProps) {
    const [isToggling, setIsToggling] = useState(false);
    const [showReasonDialog, setShowReasonDialog] = useState(false);
    const [showHistory, setShowHistory] = useState(false);
    const [imgError, setImgError] = useState(false);

    const isVideo = media.type?.startsWith("video/");

    // ── Visibility toggle handlers ─────────────────────────────────────────

    const handleHideClick = () => {
        // Opening the dialog does not count as "toggling" yet — show it first.
        setShowReasonDialog(true);
    };

    const handleUnhideClick = async () => {
        if (isToggling) return;
        setIsToggling(true);
        try {
            await onVisibilityToggle(media.media_id, false);
        } finally {
            setIsToggling(false);
        }
    };

    const handleReasonSubmit = async (reason?: string) => {
        setShowReasonDialog(false);
        setIsToggling(true);
        try {
            await onVisibilityToggle(media.media_id, true, reason);
        } finally {
            setIsToggling(false);
        }
    };

    const handleReasonCancel = () => {
        setShowReasonDialog(false);
    };

    // ── Render ─────────────────────────────────────────────────────────────

    return (
        <>
            {showReasonDialog && (
                <ReasonDialog onSubmit={handleReasonSubmit} onCancel={handleReasonCancel} />
            )}

            {showHistory && (
                <ModerationHistory
                    mediaId={media.media_id}
                    onClose={() => setShowHistory(false)}
                />
            )}

            <article
                className="relative rounded-2xl overflow-hidden flex flex-col"
                style={{
                    backgroundColor: "#FAF3EE",
                    border: "1px solid",
                    borderColor: media.is_hidden ? "#FECACA" : "#E5D9D4",
                    // Reduced opacity signals hidden state (Req 2.2)
                    opacity: media.is_hidden ? 0.7 : 1,
                    transition: "opacity 0.2s",
                }}
            >
                {/* ── Thumbnail ─────────────────────────────────────────── */}
                <div className="relative w-full" style={{ aspectRatio: "1 / 1" }}>
                    {/* Hidden-state tint overlay (Req 2.2) */}
                    {media.is_hidden && (
                        <div
                            className="absolute inset-0 z-10 pointer-events-none"
                            style={{ backgroundColor: "rgba(239, 68, 68, 0.08)" }}
                        />
                    )}

                    {/* Hidden badge – top-left corner (Req 2.1, 2.2) */}
                    {media.is_hidden && (
                        <div
                            className="absolute top-2 left-2 z-20 flex items-center gap-x-1 px-2 py-0.5 rounded-full text-xs font-semibold"
                            style={{ backgroundColor: "#FEE2E2", color: "#DC2626" }}
                        >
                            {/* Eye-off icon */}
                            <svg
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                                <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                                <line x1="1" y1="1" x2="23" y2="23" />
                            </svg>
                            Oculto
                        </div>
                    )}

                    {/* Media thumbnail */}
                    {imgError ? (
                        <div
                            className="w-full h-full flex items-center justify-center"
                            style={{ backgroundColor: "#F3EAE4" }}
                        >
                            <svg
                                width="32"
                                height="32"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="#C4A99A"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                                <circle cx="8.5" cy="8.5" r="1.5" />
                                <polyline points="21 15 16 10 5 21" />
                            </svg>
                        </div>
                    ) : isVideo ? (
                        <div className="w-full h-full flex items-center justify-center" style={{ backgroundColor: "#1C1C1E" }}>
                            <svg
                                width="32"
                                height="32"
                                viewBox="0 0 24 24"
                                fill="white"
                            >
                                <polygon points="5,3 19,12 5,21" />
                            </svg>
                        </div>
                    ) : (
                        <Image
                            src={media.content}
                            alt={`Media ${media.media_id}`}
                            fill
                            sizes="(max-width: 768px) 50vw, 25vw"
                            className="object-cover"
                            onError={() => setImgError(true)}
                        />
                    )}
                </div>

                {/* ── Info row ──────────────────────────────────────────── */}
                <div className="px-3 pt-2 pb-1 flex flex-col gap-y-0.5">
                    <span className="text-xs font-medium truncate" style={{ color: "#5A463A" }}>
                        {media.username ?? `ID ${media.media_id}`}
                    </span>
                    {media.is_hidden && media.hidden_by_username && (
                        <span className="text-xs text-gray-400 truncate">
                            Ocultado por {media.hidden_by_username}
                        </span>
                    )}
                </div>

                {/* ── Actions ───────────────────────────────────────────── */}
                <div className="px-3 pb-3 flex flex-col gap-y-2 mt-auto">
                    {/* Primary action: Hide / Unhide */}
                    <button
                        className={`w-full py-1.5 rounded-xl text-xs font-medium transition-colors ${
                            isToggling ? "opacity-50 cursor-not-allowed" : ""
                        }`}
                        style={
                            media.is_hidden
                                ? { backgroundColor: "#D1FAE5", color: "#059669" }
                                : { backgroundColor: "#FEE2E2", color: "#DC2626" }
                        }
                        onClick={media.is_hidden ? handleUnhideClick : handleHideClick}
                        disabled={isToggling}
                    >
                        {isToggling
                            ? "…"
                            : media.is_hidden
                            ? "Restaurar"
                            : "Ocultar"}
                    </button>

                    {/* Secondary action: History */}
                    <button
                        className="w-full py-1.5 rounded-xl text-xs font-medium border transition-colors hover:border-pink-200"
                        style={{ borderColor: "#E5D9D4", color: "#9CA3AF" }}
                        onClick={() => setShowHistory(true)}
                    >
                        Ver historial
                    </button>
                </div>
            </article>
        </>
    );
}
