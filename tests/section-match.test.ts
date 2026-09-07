import { describe, it, expect, vi } from "vitest";
import type { Pool } from "pg";
import { isValidTimeOfDay, resolveSectionIdByTime } from "@/lib/section-match";

describe("isValidTimeOfDay", () => {
    it("accepts HH:MM and HH:MM:SS in 24h range", () => {
        expect(isValidTimeOfDay("00:00")).toBe(true);
        expect(isValidTimeOfDay("09:05")).toBe(true);
        expect(isValidTimeOfDay("20:39")).toBe(true);
        expect(isValidTimeOfDay("23:59")).toBe(true);
        expect(isValidTimeOfDay("11:00:30")).toBe(true);
    });

    it("rejects malformed or out-of-range values", () => {
        expect(isValidTimeOfDay("24:00")).toBe(false);
        expect(isValidTimeOfDay("25:99")).toBe(false);
        expect(isValidTimeOfDay("9:5")).toBe(false);
        expect(isValidTimeOfDay("")).toBe(false);
        expect(isValidTimeOfDay(null)).toBe(false);
        expect(isValidTimeOfDay(undefined)).toBe(false);
        expect(isValidTimeOfDay(1130)).toBe(false);
    });
});

/** Build a Pool stub whose query returns the given rows. */
function poolWithRows(rows: unknown[]): { pool: Pool; queryMock: ReturnType<typeof vi.fn> } {
    const queryMock = vi.fn(async () => ({ rows }));
    const pool = { query: queryMock } as unknown as Pool;
    return { pool, queryMock };
}

describe("resolveSectionIdByTime", () => {
    it("returns null without querying when the time is null/blank/malformed", async () => {
        const { pool, queryMock } = poolWithRows([{ section_id: 5 }]);
        expect(await resolveSectionIdByTime(pool, 1, null)).toBeNull();
        expect(await resolveSectionIdByTime(pool, 1, "")).toBeNull();
        expect(await resolveSectionIdByTime(pool, 1, "nope")).toBeNull();
        expect(queryMock).not.toHaveBeenCalled();
    });

    it("returns the matched section id and queries by time-of-day", async () => {
        const { pool, queryMock } = poolWithRows([{ section_id: 42 }]);
        const id = await resolveSectionIdByTime(pool, 7, "20:39");
        expect(id).toBe(42);
        expect(queryMock).toHaveBeenCalledTimes(1);
        const [, params] = queryMock.mock.calls[0];
        expect(params).toEqual([7, "20:39"]);
    });

    it("returns null when no section covers the time", async () => {
        const { pool } = poolWithRows([]);
        expect(await resolveSectionIdByTime(pool, 7, "03:15")).toBeNull();
    });
});
