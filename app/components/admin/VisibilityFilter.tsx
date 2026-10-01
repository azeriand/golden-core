"use client";

export type VisibilityFilterValue = "all" | "visible" | "hidden";

interface VisibilityFilterProps {
    value: VisibilityFilterValue;
    onChange: (value: VisibilityFilterValue) => void;
}

/**
 * Dropdown that lets admins filter the media grid by visibility state:
 * - all    – shows every media item
 * - visible – shows only items where is_hidden = false
 * - hidden  – shows only items where is_hidden = true
 *
 * Satisfies Requirement 2.3.
 */
export default function VisibilityFilter({ value, onChange }: VisibilityFilterProps) {
    return (
        <div className="flex items-center gap-x-2">
            <label
                htmlFor="visibility-filter"
                className="text-xs font-medium"
                style={{ color: "#5A463A" }}
            >
                Visibilidad
            </label>
            <select
                id="visibility-filter"
                value={value}
                onChange={(e) => onChange(e.target.value as VisibilityFilterValue)}
                className="text-sm rounded-xl border px-3 py-1.5 outline-none transition-colors cursor-pointer"
                style={{
                    borderColor: "#E5D9D4",
                    color: "#5A463A",
                    backgroundColor: "#FFFCF8",
                    appearance: "none",
                    WebkitAppearance: "none",
                    backgroundImage:
                        "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%239CA3AF' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E\")",
                    backgroundRepeat: "no-repeat",
                    backgroundPosition: "right 0.5rem center",
                    paddingRight: "2rem",
                }}
            >
                <option value="all">Todos</option>
                <option value="visible">Visibles</option>
                <option value="hidden">Ocultos</option>
            </select>
        </div>
    );
}
