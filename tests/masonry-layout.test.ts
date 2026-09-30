// Unit tests for the segmented justified masonry layout engine. These verify
// the behaviors the feature calls for:
//   1. Every 5 items form a segment: the banner slot is filled by a LANDSCAPE
//      item, and the other four lay out as justified rows.
//   2. When the 5th item is portrait but another item in the segment is
//      landscape, that landscape item is pulled into the banner (reordering is
//      allowed) so the full-width slot is never a stretched portrait.
//   3. A segment with NO landscape item skips the banner and flows all five
//      through the grid instead.
//   4. Rows fill the container width exactly (no ragged vertical gaps), and a
//      trailing partial segment is also justified.

import { describe, expect, it } from "vitest";
import {
  computeLayout,
  LayoutInput,
  SEGMENT_SIZE,
  ROW_OF,
  FULL_WIDTH_MIN_ASPECT,
  responsiveColumns,
  segmentSizeForColumns,
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

  it("pulls a landscape item into the banner when the 5th is portrait", () => {
    // 5th (key 4) is portrait, but an earlier item (key 2) is landscape. The
    // engine must reorder so the landscape item becomes the full-width banner,
    // never stretching the portrait 5th.
    const items: LayoutInput[] = [
      { key: 0, aspect: 3 / 4 },
      { key: 1, aspect: 3 / 4 },
      { key: 2, aspect: 1.9 }, // landscape candidate
      { key: 3, aspect: 3 / 4 },
      { key: 4, aspect: 3 / 4 }, // portrait 5th
    ];
    const cells = computeLayout(items, { containerWidth: CONTAINER, gap: GAP });

    // Exactly one banner, and it is the landscape item (key 2) — NOT the 5th.
    const banners = cells.filter((c) => c.fullWidth);
    expect(banners.length).toBe(1);
    expect(banners[0].key).toBe(2);
    expect(banners[0].width).toBeCloseTo(CONTAINER, 4);
    // The portrait 5th stays a normal grid cell.
    expect(cells.find((c) => c.key === 4)?.fullWidth).toBe(false);
  });

  it("prefers the 5th item for the banner when it already qualifies", () => {
    // Both key 2 and key 4 are landscape; the 5th (key 4) is preferred to keep
    // the natural order (minimal reordering).
    const items: LayoutInput[] = [
      { key: 0, aspect: 3 / 4 },
      { key: 1, aspect: 3 / 4 },
      { key: 2, aspect: 1.5 },
      { key: 3, aspect: 3 / 4 },
      { key: 4, aspect: 1.5 },
    ];
    const cells = computeLayout(items, { containerWidth: CONTAINER, gap: GAP });
    const banners = cells.filter((c) => c.fullWidth);
    expect(banners.length).toBe(1);
    expect(banners[0].key).toBe(4);
  });

  it("skips the banner when the segment has no landscape item", () => {
    const items = inputs(5, 3 / 4); // all portrait, below FULL_WIDTH_MIN_ASPECT
    const cells = computeLayout(items, { containerWidth: CONTAINER, gap: GAP });

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

describe("responsive columns", () => {
  it("keeps two columns on narrow/mobile widths and adds columns as width grows", () => {
    expect(responsiveColumns(0)).toBe(2);
    expect(responsiveColumns(500)).toBe(2);
    expect(responsiveColumns(767)).toBe(2);
    expect(responsiveColumns(768)).toBe(3);
    expect(responsiveColumns(1200)).toBe(4);
    expect(responsiveColumns(1600)).toBe(5);
    expect(responsiveColumns(3000)).toBe(5);
  });

  it("sizes a segment as two grid rows plus one banner for any column count", () => {
    expect(segmentSizeForColumns(2)).toBe(5); // matches the default SEGMENT_SIZE
    expect(segmentSizeForColumns(3)).toBe(7);
    expect(segmentSizeForColumns(4)).toBe(9);
    expect(segmentSizeForColumns(5)).toBe(11);
  });

  it("lays out more columns per row while still justifying to the width", () => {
    const columns = 4;
    // A full segment at 4 columns: 8 portrait grid items + 1 landscape banner.
    const items: LayoutInput[] = [
      ...Array.from({ length: 8 }, (_, i) => ({ key: i, aspect: 3 / 4 })),
      { key: 8, aspect: 1.8 }, // banner candidate
    ];
    const cells = computeLayout(items, {
      containerWidth: CONTAINER,
      gap: GAP,
      rowOf: columns,
      segmentSize: segmentSizeForColumns(columns),
    });

    // Banner is the landscape item, full width, on its own row.
    const banner = cells.find((c) => c.fullWidth);
    expect(banner?.key).toBe(8);
    expect(cells.filter((c) => c.row === banner!.row).length).toBe(1);

    // The 8 grid items fill two rows of 4, each justified to the container.
    const gridRows = [...new Set(cells.filter((c) => !c.fullWidth).map((c) => c.row))];
    expect(gridRows.length).toBe(2);
    for (const r of gridRows) {
      expect(cells.filter((c) => c.row === r).length).toBe(4);
      expect(rowWidth(cells, r)).toBeCloseTo(CONTAINER, 4);
    }
  });

  it("still promotes a banner (expand logic) at wider column counts", () => {
    // 3-column segment (7 items) where only an interior item is landscape:
    // the engine must still pull it into the full-width banner.
    const columns = 3;
    const items: LayoutInput[] = [
      { key: 0, aspect: 3 / 4 },
      { key: 1, aspect: 3 / 4 },
      { key: 2, aspect: 2.1 }, // the only landscape item
      { key: 3, aspect: 3 / 4 },
      { key: 4, aspect: 3 / 4 },
      { key: 5, aspect: 3 / 4 },
      { key: 6, aspect: 3 / 4 }, // last slot is portrait
    ];
    const cells = computeLayout(items, {
      containerWidth: CONTAINER,
      gap: GAP,
      rowOf: columns,
      segmentSize: segmentSizeForColumns(columns),
    });
    const banners = cells.filter((c) => c.fullWidth);
    expect(banners.length).toBe(1);
    expect(banners[0].key).toBe(2);
  });
});
