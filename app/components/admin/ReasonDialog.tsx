"use client";

import { useRef, useState } from "react";

const MAX_REASON_LENGTH = 500;

interface ReasonDialogProps {
    /** Called when the admin confirms the hide action (reason may be empty). */
    onSubmit: (reason?: string) => void;
    /** Called when the admin cancels. */
    onCancel: () => void;
}

/**
 * Modal dialog that captures an optional moderation reason before hiding a
 * media item. Enforces the 500-character limit (Req 5.4) and shows a live
 * character counter (Req 5.1). Submitting with an empty textarea passes
 * undefined so callers can distinguish "no reason" from an empty string.
 */
export default function ReasonDialog({ onSubmit, onCancel }: ReasonDialogProps) {
    const [reason, setReason] = useState("");
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    const remaining = MAX_REASON_LENGTH - reason.length;
    const isOverLimit = remaining < 0;

    const handleSubmit = () => {
        if (isOverLimit) return;
        onSubmit(reason.trim() || undefined);
    };

    const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
        if (e.target === e.currentTarget) onCancel();
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        // Ctrl/Cmd+Enter submits; plain Enter is allowed inside the textarea
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            handleSubmit();
        }
        if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
        }
    };

    return (
        <div
            className="fixed inset-0 z-[300] flex items-center justify-center bg-black/50 p-4" /* z-[300]: sits above media cards, below the main error-popup (z-[400]) */
            style={{ backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)" }}
            onClick={handleBackdropClick}
        >
            <div
                className="bg-[#FFFCF8] rounded-2xl p-6 max-w-sm w-full flex flex-col gap-y-4"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex flex-col gap-y-1">
                    <p className="text-sm font-semibold" style={{ color: "#5A463A" }}>
                        Ocultar imagen
                    </p>
                    <p className="text-xs text-gray-400">
                        Puedes añadir un motivo opcional para documentar la decisión.
                    </p>
                </div>

                {/* Textarea */}
                <div className="flex flex-col gap-y-1">
                    <textarea
                        ref={textareaRef}
                        autoFocus
                        rows={4}
                        placeholder="Motivo de moderación (opcional)…"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        onKeyDown={handleKeyDown}
                        className="w-full resize-none rounded-xl border text-sm p-3 outline-none transition-colors"
                        style={{
                            borderColor: isOverLimit ? "#F87171" : "#E5D9D4",
                            color: "#5A463A",
                            backgroundColor: "#FFFCF8",
                        }}
                        maxLength={MAX_REASON_LENGTH + 1} // allow typing past limit so the counter turns red
                    />
                    {/* Character counter */}
                    <span
                        className="text-xs text-right"
                        style={{ color: isOverLimit ? "#EF4444" : "#9CA3AF" }}
                    >
                        {reason.length}/{MAX_REASON_LENGTH}
                    </span>
                </div>

                {/* Actions */}
                <div className="flex gap-x-3 w-full">
                    <button
                        className="flex-1 py-2 rounded-xl text-sm font-medium border border-gray-200"
                        style={{ color: "#5A463A" }}
                        onClick={onCancel}
                    >
                        Cancelar
                    </button>
                    <button
                        className={`flex-1 py-2 rounded-xl text-sm font-medium text-white transition-colors ${
                            isOverLimit
                                ? "bg-pink-300 cursor-not-allowed"
                                : "bg-pink-500 hover:bg-pink-600"
                        }`}
                        onClick={handleSubmit}
                        disabled={isOverLimit}
                    >
                        Ocultar
                    </button>
                </div>
            </div>
        </div>
    );
}
