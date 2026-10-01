"use client";

import { useEffect, useState } from "react";
import { ModerationLogEntry } from "../../dto/admin-media";

interface ModerationHistoryProps {
    mediaId: number;
    onClose: () => void;
}

/**
 * Modal that fetches and renders the full moderation history for a given media
 * item via GET /api/admin/media/[media_id]/history. Displays admin username,
 * action (hide / unhide), timestamp, and optional reason for each entry.
 *
 * Satisfies Requirements 4.3, 4.4, 5.3.
 */
export default function ModerationHistory({ mediaId, onClose }: ModerationHistoryProps) {
    const [history, setHistory] = useState<ModerationLogEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        setLoading(true);
        setError(null);

        fetch(`/api/admin/media/${mediaId}/history`)
            .then(async (res) => {
                if (!res.ok) {
                    throw new Error(`Error ${res.status}`);
                }
                return res.json();
            })
            .then((data: { history: ModerationLogEntry[] }) => {
                setHistory(data.history);
            })
            .catch((err: Error) => {
                console.error("Error fetching moderation history:", err);
                setError("No se pudo cargar el historial.");
            })
            .finally(() => {
                setLoading(false);
            });
    }, [mediaId]);

    const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
        if (e.target === e.currentTarget) onClose();
    };

    return (
        <div
            className="fixed inset-0 z-[300] flex items-center justify-center bg-black/50 p-4"
            style={{ backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)" }}
            onClick={handleBackdropClick}
        >
            <div
                className="bg-[#FFFCF8] rounded-2xl p-6 max-w-sm w-full flex flex-col gap-y-4 max-h-[80vh]"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold" style={{ color: "#5A463A" }}>
                        Historial de moderación
                    </p>
                    <button
                        onClick={onClose}
                        className="text-gray-400 hover:text-gray-600 transition-colors"
                        aria-label="Cerrar historial"
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto">
                    {loading && (
                        <div className="flex items-center justify-center py-8">
                            <div
                                className="animate-spin rounded-full"
                                style={{
                                    width: "28px",
                                    height: "28px",
                                    border: "3px solid #F8D6E4",
                                    borderTopColor: "#E83E8C",
                                }}
                            />
                        </div>
                    )}

                    {!loading && error && (
                        <p className="text-center text-sm text-red-400 py-4">{error}</p>
                    )}

                    {!loading && !error && history.length === 0 && (
                        <p className="text-center text-sm text-gray-400 py-4">
                            Sin historial de moderación.
                        </p>
                    )}

                    {!loading && !error && history.length > 0 && (
                        <ul className="flex flex-col gap-y-3">
                            {history.map((entry) => (
                                <li
                                    key={entry.log_id}
                                    className="flex flex-col gap-y-1 p-3 rounded-xl"
                                    style={{ backgroundColor: "#FAF3EE" }}
                                >
                                    {/* Action badge + admin */}
                                    <div className="flex items-center gap-x-2">
                                        <span
                                            className="text-xs font-semibold px-2 py-0.5 rounded-full"
                                            style={{
                                                backgroundColor:
                                                    entry.action === "hide"
                                                        ? "#FEE2E2"
                                                        : "#D1FAE5",
                                                color:
                                                    entry.action === "hide"
                                                        ? "#DC2626"
                                                        : "#059669",
                                            }}
                                        >
                                            {entry.action === "hide" ? "Ocultado" : "Restaurado"}
                                        </span>
                                        <span className="text-xs text-gray-500">
                                            por{" "}
                                            <strong style={{ color: "#5A463A" }}>
                                                {entry.admin_username}
                                            </strong>
                                        </span>
                                    </div>

                                    {/* Timestamp */}
                                    <time
                                        dateTime={entry.created_at}
                                        className="text-xs text-gray-400"
                                    >
                                        {new Date(entry.created_at).toLocaleString("es", {
                                            day: "2-digit",
                                            month: "short",
                                            year: "numeric",
                                            hour: "2-digit",
                                            minute: "2-digit",
                                        })}
                                    </time>

                                    {/* Optional reason */}
                                    {entry.reason && (
                                        <p
                                            className="text-xs mt-0.5 italic"
                                            style={{ color: "#7A6358" }}
                                        >
                                            "{entry.reason}"
                                        </p>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>

                {/* Footer */}
                <button
                    className="w-full py-2 rounded-xl text-sm font-medium border border-gray-200 transition-colors hover:border-pink-200"
                    style={{ color: "#5A463A" }}
                    onClick={onClose}
                >
                    Cerrar
                </button>
            </div>
        </div>
    );
}
