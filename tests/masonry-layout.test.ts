// Unit tests for the segmented justified masonry layout engine. These verify
// the three behaviors the feature calls for:
//   1. Every 5 items form a segment: first 4 laid out as justified rows, the
//      5th promoted to a full-width banner WHEN it is landscape.
//   2. A non-landscape 5th item is demoted and flows through the grid instead.
//   3. Rows fill the container width exactly (no ragged vertical gaps), and a
//      trailing partial segment is also justified.

import { describe, expect, it } from "vitest";
import {
  computeLayout,
  LayoutInput,
  SEGMENT_SIZE,
  ROW_OF,
  FULL_WIDTH_MIN_ASPECT,
} from "../lib/masonry-layout";

const CONTAINER = 800;
const GAP = 4;

// Build N inputs all sharing the given aspect (default portrait 3:4).
function inputs(n: number, aspect: number | null = 3 / 4): LayoutInput[] {
  return Array.from({ length: n }, (_, i) => ({ key: i, aspect }));
}

// Sum of widths + gaps for the cells sharing a row index.
function rowWidth(cells: ReturnType<typeof computeLayout>, row: number): number {
  const inRow = cells.filter((c) => c.row === row);
  const gaps = GAP * (inRow.length - 1);
  return inRow.reduce((s, c) => s + c.width, 0) + gaps;
}

describe("computeLayout", () => {
  it("returns nothing for empty input or zero width", () => {
    expect(computeLayout([], { containerWidth: CONTAINER })).toEqual([]);
    expect(computeLayout(inputs(3), { containerWidth: 0 })).toEqual([]);
  });

  it("justifies each row to fill the container width exactly", () => {
    const cells = computeLayout(inputs(4), { containerWidth: CONTAINER, gap: GAP });
    // 4 portrait items -> two rows of two (ROW_OF = 2).
    const rowIndexes = [...new Set(cells.map((c) => c.row))];
    expect(rowIndexes.length).toBe(2);
    for (const r of rowIndexes) {
      expect(rowWidth(cells, r)).toBeCloseTo(CONTAINER, 4);
    }
  });

  it("promotes a landscape 5th item to a full-width banner", () => {
    const items = inputs(4);
    items.push({ key: 4, aspect: 1.8 }); // clearly landscape
    const cells = computeLayout(items, { containerWidth: CONTAINER, gap: GAP });

    const banner = cells.find((c) => c.key === 4);
    expect(banner?.fullWidth).toBe(true);
    expect(banner?.width).toBeCloseTo(CONTAINER, 4);
    // Banner height keeps its aspect: width / aspect.
    expect(banner?.height).toBeCloseTo(CONTAINER / 1.8, 2);
    // The banner occupies its own row.
    const bannerRowCells = cells.filter((c) => c.row === banner!.row);
    expect(bannerRowCells.length).toBe(1);
  });

  it("demotes a non-landscape 5th item into the grid flow", () => {
    const items = inputs(4);
    items.push({ key: 4, aspect: 1.0 }); // square: below FULL_WIDTH_MIN_ASPECT
    const cells = computeLayout(items, { containerWidth: CONTAINER, gap: GAP });

    const fifth = cells.find((c) => c.key === 4);
    expect(fifth?.fullWidth).toBe(false);
    // No cell in the segment is full width.
    expect(cells.some((c) => c.fullWidth)).toBe(false);
    // 5 items in rows of 2 -> 3 rows (2 + 2 + 1), each filling the width.
    const rowIndexes = [...new Set(cells.map((c) => c.row))];
    expect(rowIndexes.length).toBe(3);
    for (const r of rowIndexes) {
      expect(rowWidth(cells, r)).toBeCloseTo(CONTAINER, 4);
    }
  });

  it("justifies a trailing partial segment", () => {
    // 5 (full segment, landscape banner) + 3 trailing.
    const items = [...inputs(4), { key: 4, aspect: 2 }, ...inputs(3).map((it, i) => ({ ...it, key: 100 + i }))];
    const cells = computeLayout(items, { containerWidth: CONTAINER, gap: GAP });

    // Trailing 3 -> rows of 2 (2 + 1). Every row still fills the width.
    const rowIndexes = [...new Set(cells.map((c) => c.row))];
    for (const r of rowIndexes) {
      expect(rowWidth(cells, r)).toBeCloseTo(CONTAINER, 4);
    }
  });

  it("uses a default aspect for unmeasured items so layout stays stable", () => {
    const cells = computeLayout(inputs(2, null), { containerWidth: CONTAINER, gap: GAP });
    expect(cells.length).toBe(2);
    expect(rowWidth(cells, 0)).toBeCloseTo(CONTAINER, 4);
    // Both cells share the same positive height.
    expect(cells[0].height).toBeGreaterThan(0);
    expect(cells[0].height).toBeCloseTo(cells[1].height, 6);
  });

  it("exposes the tuning constants used by the renderer", () => {
    expect(SEGMENT_SIZE).toBe(5);
    expect(ROW_OF).toBe(2);
    expect(FULL_WIDTH_MIN_ASPECT).toBeGreaterThan(1);
  });
});
