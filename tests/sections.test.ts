import { describe, it, expect } from "vitest";
import {
    UNCLASSIFIED_SECTION_ID,
    isUnclassifiedSectionId,
} from "@/lib/sections";

describe("isUnclassifiedSectionId", () => {
    it("matches the hardcoded sentinel id (string and number-coerced forms)", () => {
        expect(isUnclassifiedSectionId(UNCLASSIFIED_SECTION_ID)).toBe(true);
        expect(isUnclassifiedSectionId("unclassified")).toBe(true);
    });

    it("does not match real numeric section ids", () => {
        expect(isUnclassifiedSectionId(1)).toBe(false);
        expect(isUnclassifiedSectionId("1")).toBe(false);
        expect(isUnclassifiedSectionId(99)).toBe(false);
    });

    it("does not match null/undefined", () => {
        expect(isUnclassifiedSectionId(null)).toBe(false);
        expect(isUnclassifiedSectionId(undefined)).toBe(false);
    });
});
