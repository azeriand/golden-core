// @vitest-environment jsdom
//
// Unit tests for admin UI components (Task 7.5).
//
// Components under test:
//   - MediaItemCard  (app/components/admin/MediaItemCard.tsx)
//   - VisibilityFilter (app/components/admin/VisibilityFilter.tsx)
//   - ReasonDialog   (app/components/admin/ReasonDialog.tsx)
//   - ModerationHistory (app/components/admin/ModerationHistory.tsx)
//
// Strategy:
//   - next/image is mocked so jsdom doesn't need a Next.js server to resolve
//     the optimiser URL; it renders a plain <img> instead.
//   - ModerationHistory uses the global fetch — it is replaced with vi.fn()
//     per-test so no network is needed.
//   - Assertions use standard vitest matchers (.toBeTruthy(), .toBeNull(),
//     .toBe(), .toHaveBeenCalledWith(), etc.) — no jest-dom extension required.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";

// ── next/image mock ────────────────────────────────────────────────────────────
// next/image has no standalone jsdom runtime. Replace it with a minimal <img>
// that forwards src and alt so assertions on rendered images still work.
vi.mock("next/image", () => ({
    default: ({
        src,
        alt,
        onError,
        ...rest
    }: {
        src: string;
        alt: string;
        onError?: () => void;
        [key: string]: unknown;
    }) => {
        const { fill: _fill, sizes: _sizes, ...imgRest } = rest as Record<string, unknown>;
        return <img src={src} alt={alt} onError={onError} {...imgRest} />;
    },
}));

import MediaItemCard from "../app/components/admin/MediaItemCard";
import VisibilityFilter, {
    type VisibilityFilterValue,
} from "../app/components/admin/VisibilityFilter";
import ReasonDialog from "../app/components/admin/ReasonDialog";
import ModerationHistory from "../app/components/admin/ModerationHistory";
import type { AdminMedia } from "../app/dto/admin-media";
import type { ModerationLogEntry } from "../app/dto/admin-media";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeMedia(overrides: Partial<AdminMedia> = {}): AdminMedia {
    return {
        media_id: 42,
        user_id: 1,
        content: "https://example.com/image.jpg",
        type: "image/jpeg",
        likes: 0,
        liked: false,
        date: "2024-01-01T00:00:00Z",
        section_id: null,
        blurhash: null,
        username: "alice",
        poster_url: null,
        original_url: null,
        width: null,
        height: null,
        is_hidden: false,
        hidden_at: null,
        hidden_by: null,
        hidden_by_username: null,
        ...overrides,
    };
}

function makeLogEntry(overrides: Partial<ModerationLogEntry> = {}): ModerationLogEntry {
    return {
        log_id: 1,
        media_id: 42,
        admin_id: 99,
        admin_username: "adminUser",
        action: "hide",
        reason: "Contains inappropriate content",
        created_at: "2024-06-15T10:00:00Z",
        ...overrides,
    };
}

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════════
// MediaItemCard
// ═══════════════════════════════════════════════════════════════════════════════

describe("MediaItemCard — hidden state (Req 2.1, 2.2)", () => {
    it("shows the 'Oculto' badge when is_hidden=true", () => {
        render(
            <MediaItemCard
                media={makeMedia({ is_hidden: true })}
                onVisibilityToggle={vi.fn()}
            />,
        );

        // Req 2.1: a visual indicator distinguishes hidden items.
        expect(screen.getByText("Oculto")).toBeTruthy();
    });

    it("does NOT show the 'Oculto' badge when is_hidden=false", () => {
        render(
            <MediaItemCard
                media={makeMedia({ is_hidden: false })}
                onVisibilityToggle={vi.fn()}
            />,
        );

        expect(screen.queryByText("Oculto")).toBeNull();
    });

    it("applies reduced opacity (0.7) styling for hidden items (Req 2.2)", () => {
        const { container } = render(
            <MediaItemCard
                media={makeMedia({ is_hidden: true })}
                onVisibilityToggle={vi.fn()}
            />,
        );

        // The <article> element carries the opacity style for hidden items.
        const article = container.querySelector("article");
        expect(article).not.toBeNull();
        expect((article as HTMLElement).style.opacity).toBe("0.7");
    });

    it("does NOT apply reduced opacity for visible items (opacity=1) (Req 2.2)", () => {
        const { container } = render(
            <MediaItemCard
                media={makeMedia({ is_hidden: false })}
                onVisibilityToggle={vi.fn()}
            />,
        );

        const article = container.querySelector("article");
        expect(article).not.toBeNull();
        expect((article as HTMLElement).style.opacity).toBe("1");
    });

    it("shows 'Ocultado por {username}' when hidden_by_username is set", () => {
        render(
            <MediaItemCard
                media={makeMedia({
                    is_hidden: true,
                    hidden_by: 5,
                    hidden_by_username: "moderator1",
                })}
                onVisibilityToggle={vi.fn()}
            />,
        );

        expect(screen.queryByText(/Ocultado por moderator1/)).toBeTruthy();
    });
});

describe("MediaItemCard — toggle actions (Req 1.1, 1.2, 1.3)", () => {
    it("shows 'Ocultar' button for a visible item", () => {
        render(
            <MediaItemCard
                media={makeMedia({ is_hidden: false })}
                onVisibilityToggle={vi.fn()}
            />,
        );

        expect(screen.queryByRole("button", { name: "Ocultar" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Restaurar" })).toBeNull();
    });

    it("shows 'Restaurar' button for a hidden item", () => {
        render(
            <MediaItemCard
                media={makeMedia({ is_hidden: true })}
                onVisibilityToggle={vi.fn()}
            />,
        );

        expect(screen.queryByRole("button", { name: "Restaurar" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Ocultar" })).toBeNull();
    });

    it("clicking 'Ocultar' opens the ReasonDialog (Req 5.1)", () => {
        render(
            <MediaItemCard
                media={makeMedia({ is_hidden: false })}
                onVisibilityToggle={vi.fn()}
            />,
        );

        // Before click: dialog should not be visible.
        expect(screen.queryByText("Ocultar imagen")).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Ocultar" }));

        // After click: ReasonDialog header is visible.
        expect(screen.queryByText("Ocultar imagen")).toBeTruthy();
    });

    it("clicking 'Restaurar' calls onVisibilityToggle with (id, false) — no dialog (Req 1.3)", async () => {
        const toggleFn = vi.fn().mockResolvedValue(undefined);

        render(
            <MediaItemCard
                media={makeMedia({ is_hidden: true, media_id: 42 })}
                onVisibilityToggle={toggleFn}
            />,
        );

        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Restaurar" }));
        });

        expect(toggleFn).toHaveBeenCalledTimes(1);
        expect(toggleFn).toHaveBeenCalledWith(42, false);
        // Dialog must NOT have opened.
        expect(screen.queryByText("Ocultar imagen")).toBeNull();
    });

    it("submitting the ReasonDialog calls onVisibilityToggle with (id, true, reason) (Req 1.2)", async () => {
        const toggleFn = vi.fn().mockResolvedValue(undefined);

        render(
            <MediaItemCard
                media={makeMedia({ is_hidden: false, media_id: 42 })}
                onVisibilityToggle={toggleFn}
            />,
        );

        // Open dialog.
        fireEvent.click(screen.getByRole("button", { name: "Ocultar" }));

        // Type a reason in the dialog textarea.
        const textarea = screen.getByPlaceholderText(/Motivo de moderación/);
        fireEvent.change(textarea, { target: { value: "Spam content" } });

        // When the dialog is open there are two "Ocultar" buttons in the tree:
        // the card's own button and the dialog's submit button. We scope the
        // click to the dialog card element to target only the dialog's button.
        const dialogCard = screen
            .getByText("Ocultar imagen")
            .closest("div[class*='rounded-2xl']") as HTMLElement;

        await act(async () => {
            fireEvent.click(
                within(dialogCard).getByRole("button", { name: "Ocultar" }),
            );
        });

        expect(toggleFn).toHaveBeenCalledTimes(1);
        expect(toggleFn).toHaveBeenCalledWith(42, true, "Spam content");
    });

    it("cancelling the ReasonDialog does NOT call onVisibilityToggle", () => {
        const toggleFn = vi.fn();

        render(
            <MediaItemCard
                media={makeMedia({ is_hidden: false })}
                onVisibilityToggle={toggleFn}
            />,
        );

        fireEvent.click(screen.getByRole("button", { name: "Ocultar" }));
        expect(screen.queryByText("Ocultar imagen")).toBeTruthy();

        fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));

        expect(toggleFn).not.toHaveBeenCalled();
        expect(screen.queryByText("Ocultar imagen")).toBeNull();
    });

    it("clicking 'Ver historial' opens the ModerationHistory modal (Req 4.3)", async () => {
        // Mock fetch so ModerationHistory doesn't crash.
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ history: [] }),
            }),
        );

        render(
            <MediaItemCard
                media={makeMedia({ media_id: 42 })}
                onVisibilityToggle={vi.fn()}
            />,
        );

        fireEvent.click(screen.getByRole("button", { name: "Ver historial" }));

        // ModerationHistory modal header must appear.
        await waitFor(() => {
            expect(screen.queryByText("Historial de moderación")).toBeTruthy();
        });
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// VisibilityFilter
// ═══════════════════════════════════════════════════════════════════════════════

describe("VisibilityFilter (Req 2.3)", () => {
    it("renders all three options: Todos, Visibles, Ocultos", () => {
        render(<VisibilityFilter value="all" onChange={vi.fn()} />);

        const select = screen.getByRole("combobox");
        const options = within(select).getAllByRole("option");

        expect(options).toHaveLength(3);
        // Values map to the enum variants used by the API filter.
        expect((options[0] as HTMLOptionElement).value).toBe("all");
        expect((options[1] as HTMLOptionElement).value).toBe("visible");
        expect((options[2] as HTMLOptionElement).value).toBe("hidden");
    });

    it("reflects the current value as the selected option", () => {
        render(<VisibilityFilter value="hidden" onChange={vi.fn()} />);

        const select = screen.getByRole("combobox") as HTMLSelectElement;
        expect(select.value).toBe("hidden");
    });

    it.each([
        ["all" as VisibilityFilterValue],
        ["visible" as VisibilityFilterValue],
        ["hidden" as VisibilityFilterValue],
    ])(
        "calls onChange with '%s' when the user changes the select",
        (value) => {
            const onChange = vi.fn();
            render(<VisibilityFilter value="all" onChange={onChange} />);

            fireEvent.change(screen.getByRole("combobox"), {
                target: { value },
            });

            expect(onChange).toHaveBeenCalledTimes(1);
            expect(onChange).toHaveBeenCalledWith(value);
        },
    );

    it("has a visible 'Visibilidad' label linked to the select", () => {
        render(<VisibilityFilter value="all" onChange={vi.fn()} />);
        expect(screen.queryByText("Visibilidad")).toBeTruthy();
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ReasonDialog
// ═══════════════════════════════════════════════════════════════════════════════

describe("ReasonDialog — character counter (Req 5.1, 5.4)", () => {
    it("shows '0/500' when the textarea is empty", () => {
        render(<ReasonDialog onSubmit={vi.fn()} onCancel={vi.fn()} />);
        expect(screen.queryByText("0/500")).toBeTruthy();
    });

    it("updates the counter live as the user types", () => {
        render(<ReasonDialog onSubmit={vi.fn()} onCancel={vi.fn()} />);

        const textarea = screen.getByPlaceholderText(/Motivo de moderación/);
        fireEvent.change(textarea, { target: { value: "hello" } });

        expect(screen.queryByText("5/500")).toBeTruthy();
    });

    it("disables the submit button when the reason exceeds 500 characters (Req 5.4)", () => {
        render(<ReasonDialog onSubmit={vi.fn()} onCancel={vi.fn()} />);

        const textarea = screen.getByPlaceholderText(/Motivo de moderación/);
        fireEvent.change(textarea, { target: { value: "a".repeat(501) } });

        const submitBtn = screen.getByRole("button", { name: "Ocultar" }) as HTMLButtonElement;
        expect(submitBtn.disabled).toBe(true);
    });

    it("enables the submit button for exactly 500 characters", () => {
        render(<ReasonDialog onSubmit={vi.fn()} onCancel={vi.fn()} />);

        const textarea = screen.getByPlaceholderText(/Motivo de moderación/);
        fireEvent.change(textarea, { target: { value: "b".repeat(500) } });

        const submitBtn = screen.getByRole("button", { name: "Ocultar" }) as HTMLButtonElement;
        expect(submitBtn.disabled).toBe(false);
    });
});

describe("ReasonDialog — submission behaviour", () => {
    it("calls onSubmit with the trimmed reason on confirm", () => {
        const onSubmit = vi.fn();
        render(<ReasonDialog onSubmit={onSubmit} onCancel={vi.fn()} />);

        const textarea = screen.getByPlaceholderText(/Motivo de moderación/);
        fireEvent.change(textarea, { target: { value: "  nudity  " } });
        fireEvent.click(screen.getByRole("button", { name: "Ocultar" }));

        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(onSubmit).toHaveBeenCalledWith("nudity");
    });

    it("calls onSubmit with undefined when the textarea is empty", () => {
        const onSubmit = vi.fn();
        render(<ReasonDialog onSubmit={onSubmit} onCancel={vi.fn()} />);

        fireEvent.click(screen.getByRole("button", { name: "Ocultar" }));

        expect(onSubmit).toHaveBeenCalledWith(undefined);
    });

    it("calls onSubmit with undefined when the reason is only whitespace", () => {
        const onSubmit = vi.fn();
        render(<ReasonDialog onSubmit={onSubmit} onCancel={vi.fn()} />);

        const textarea = screen.getByPlaceholderText(/Motivo de moderación/);
        fireEvent.change(textarea, { target: { value: "   " } });
        fireEvent.click(screen.getByRole("button", { name: "Ocultar" }));

        expect(onSubmit).toHaveBeenCalledWith(undefined);
    });

    it("does NOT call onSubmit when reason exceeds 500 characters", () => {
        const onSubmit = vi.fn();
        render(<ReasonDialog onSubmit={onSubmit} onCancel={vi.fn()} />);

        const textarea = screen.getByPlaceholderText(/Motivo de moderación/);
        fireEvent.change(textarea, { target: { value: "x".repeat(501) } });
        // Clicking a disabled button should be a no-op, but fireEvent bypasses
        // the disabled check — the component guard (isOverLimit) prevents the
        // call even when fireEvent forces the click.
        fireEvent.click(screen.getByRole("button", { name: "Ocultar" }));

        expect(onSubmit).not.toHaveBeenCalled();
    });
});

describe("ReasonDialog — cancel behaviour", () => {
    it("calls onCancel when the Cancelar button is clicked", () => {
        const onCancel = vi.fn();
        render(<ReasonDialog onSubmit={vi.fn()} onCancel={onCancel} />);

        fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));

        expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("calls onCancel when Escape is pressed in the textarea", () => {
        const onCancel = vi.fn();
        render(<ReasonDialog onSubmit={vi.fn()} onCancel={onCancel} />);

        const textarea = screen.getByPlaceholderText(/Motivo de moderación/);
        fireEvent.keyDown(textarea, { key: "Escape" });

        expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("calls onCancel when clicking the backdrop (outside the card)", () => {
        const onCancel = vi.fn();
        const { container } = render(
            <ReasonDialog onSubmit={vi.fn()} onCancel={onCancel} />,
        );

        // The backdrop is the outermost fixed div; the handleBackdropClick handler
        // fires only when e.target === e.currentTarget (i.e. the backdrop itself).
        const backdrop = container.firstChild as HTMLElement;
        fireEvent.click(backdrop);

        expect(onCancel).toHaveBeenCalledTimes(1);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ModerationHistory
// ═══════════════════════════════════════════════════════════════════════════════

describe("ModerationHistory — loading state (Req 4.3)", () => {
    beforeEach(() => {
        // Return a promise that never resolves so the component stays loading.
        vi.stubGlobal(
            "fetch",
            vi.fn().mockReturnValue(new Promise(() => {})),
        );
    });

    it("shows a loading spinner while the request is in flight", () => {
        const { container } = render(
            <ModerationHistory mediaId={42} onClose={vi.fn()} />,
        );

        // The spinner is an `animate-spin` div defined in the component.
        expect(container.querySelector(".animate-spin")).not.toBeNull();
        // No history list items yet.
        expect(screen.queryByRole("listitem")).toBeNull();
    });
});

describe("ModerationHistory — populated history (Req 4.3, 4.4, 5.3)", () => {
    it("renders each entry with action badge, admin username, timestamp, and reason", async () => {
        const entries: ModerationLogEntry[] = [
            makeLogEntry({
                log_id: 1,
                action: "hide",
                admin_username: "adminAlice",
                reason: "Violates policy",
                created_at: "2024-06-15T10:00:00Z",
            }),
            makeLogEntry({
                log_id: 2,
                action: "unhide",
                admin_username: "adminBob",
                reason: null,
                created_at: "2024-06-16T12:00:00Z",
            }),
        ];

        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ history: entries }),
            }),
        );

        render(<ModerationHistory mediaId={42} onClose={vi.fn()} />);

        // Wait for loading to finish and entries to appear.
        await waitFor(() => {
            expect(screen.queryByText("Ocultado")).toBeTruthy();
        });

        // Action badges (Req 4.4): "hide" → "Ocultado", "unhide" → "Restaurado".
        expect(screen.queryByText("Ocultado")).toBeTruthy();
        expect(screen.queryByText("Restaurado")).toBeTruthy();

        // Admin usernames (Req 4.4).
        expect(screen.queryByText("adminAlice")).toBeTruthy();
        expect(screen.queryByText("adminBob")).toBeTruthy();

        // Reason quoted for first entry (Req 5.3).
        expect(screen.queryByText(/"Violates policy"/)).toBeTruthy();

        // Two list items total.
        const items = screen.getAllByRole("listitem");
        expect(items).toHaveLength(2);
    });
});

describe("ModerationHistory — empty state (Req 4.3)", () => {
    it("shows 'Sin historial de moderación.' when there are no entries", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ history: [] }),
            }),
        );

        render(<ModerationHistory mediaId={42} onClose={vi.fn()} />);

        await waitFor(() => {
            expect(screen.queryByText("Sin historial de moderación.")).toBeTruthy();
        });

        // Spinner must be gone.
        expect(screen.queryByRole("listitem")).toBeNull();
    });
});

describe("ModerationHistory — error state", () => {
    it("shows an error message when the HTTP response is not ok", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: false,
                status: 500,
                json: async () => ({}),
            }),
        );

        render(<ModerationHistory mediaId={42} onClose={vi.fn()} />);

        await waitFor(() => {
            expect(screen.queryByText("No se pudo cargar el historial.")).toBeTruthy();
        });
    });
});

describe("ModerationHistory — close behaviour", () => {
    async function renderAndWaitForLoad(onClose: ReturnType<typeof vi.fn>) {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ history: [] }),
            }),
        );

        render(<ModerationHistory mediaId={42} onClose={onClose} />);

        await waitFor(() => {
            expect(screen.queryByText("Sin historial de moderación.")).toBeTruthy();
        });
    }

    it("calls onClose when the ✕ icon button is clicked", async () => {
        const onClose = vi.fn();
        await renderAndWaitForLoad(onClose);

        fireEvent.click(screen.getByRole("button", { name: "Cerrar historial" }));
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("calls onClose when the footer 'Cerrar' button is clicked", async () => {
        const onClose = vi.fn();
        await renderAndWaitForLoad(onClose);

        fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
