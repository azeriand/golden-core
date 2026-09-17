// Segmented "justified gallery" layout engine for the media grid.
//
// The gallery is split into fixed-size SEGMENTS (default 5 items). Each segment
// is laid out so its rows exactly fill the container width, leaving no ragged
// vertical gaps (unlike a plain two-column masonry where each column ends at a
// different height):
//
//   - Items 1..4 of a segment are arranged as a justified grid of ROWS_OF (2)
//     images per row (i.e. two rows of two). Each row is scaled so the combined
//     image widths + gaps fill the container width exactly; the row height is
//     derived from the images' aspect ratios. Images fill their computed box via
//     `object-cover`, so a slight aspect distortion is acceptable (the box is
//     sized from the true aspect, cover only trims sub-pixel rounding).
//
//   - The 5th item becomes a FULL-WIDTH banner spanning the whole row, but ONLY
//     when it is landscape (aspect >= FULL_WIDTH_MIN_ASPECT). A portrait/!square
//     5th item would look wrong stretched across the full width, so it is demoted
//     to a normal grid item and flows with the segment's grid rows instead.
//
//   - Trailing items (a final partial segment, or a segment whose 5th item was
//     demoted) are packed into justified rows of up to ROWS_OF items, with the
//     final row also scaled to fill the width so nothing is left ragged.
//
// The engine is pure and framework-agnostic so it can be unit tested without a
// DOM: given the ordered item aspect ratios and a container width, it returns
// absolute box sizes the renderer applies.

/** Number of items per segment. The Nth item is the full-width candidate. */
export const SEGMENT_SIZE = 5;

/** Images per justified row within the grid portion of a segment. */
export const ROW_OF = 2;

/**
 * Minimum aspect ratio (width / height) for the segment's last item to be
 * promoted to a full-width banner. Anything narrower flows as a normal grid
 * item. 1.2 keeps clearly-landscape shots as banners while demoting square-ish
 * and portrait ones.
 */
export const FULL_WIDTH_MIN_ASPECT = 1.2;

/** Fallback aspect ratio (w/h) used before an image's real size is known. */
export const DEFAULT_ASPECT = 3 / 4;

export interface LayoutInput {
  /** Stable key for the item (used by the renderer for React keys). */
  key: string | number;
  /**
   * Aspect ratio width / height. When unknown (image not yet measured) pass
   * null; the engine substitutes DEFAULT_ASPECT so layout is still stable.
   */
  aspect: number | null;
}

/** A single positioned cell in the computed layout. */
export interface LayoutCell {
  key: string | number;
  /** Rendered width in px. */
  width: number;
  /** Rendered height in px. */
  height: number;
  /** True when this cell spans the full container width (the banner). */
  fullWidth: boolean;
  /** Index of the row this cell belongs to (for flex-wrap grouping). */
  row: number;
}

export interface LayoutOptions {
  containerWidth: number;
  /** Gap in px between items (both axes). */
  gap?: number;
  segmentSize?: number;
  rowOf?: number;
  fullWidthMinAspect?: number;
}

/**
 * Compute justified box sizes for a list of items. Rows are grouped by the
 * returned `row` index; consecutive cells with the same `row` share a row and
 * their widths + gaps sum to (approximately) the container width.
 */
export function computeLayout(items: LayoutInput[], options: LayoutOptions): LayoutCell[] {
  const {
    containerWidth,
    gap = 4,
    segmentSize = SEGMENT_SIZE,
    rowOf = ROW_OF,
    fullWidthMinAspect = FULL_WIDTH_MIN_ASPECT,
  } = options;

  if (containerWidth <= 0 || items.length === 0) return [];

  const cells: LayoutCell[] = [];
  let rowCounter = 0;

  // Normalize aspect ratios up front so downstream math never sees null/<=0.
  const aspectOf = (item: LayoutInput): number =>
    item.aspect && item.aspect > 0 ? item.aspect : DEFAULT_ASPECT;

  // Emit one justified row: scale the group so total width + gaps == container.
  // rowHeight = (containerWidth - totalGap) / sum(aspect). Each item's width is
  // aspect * rowHeight, so widths + gaps fill the container exactly.
  const emitRow = (group: LayoutInput[]) => {
    if (group.length === 0) return;
    const totalGap = gap * (group.length - 1);
    const usable = Math.max(1, containerWidth - totalGap);
    const aspectSum = group.reduce((sum, it) => sum + aspectOf(it), 0);
    const rowHeight = usable / aspectSum;
    for (const it of group) {
      cells.push({
        key: it.key,
        width: aspectOf(it) * rowHeight,
        height: rowHeight,
        fullWidth: false,
        row: rowCounter,
      });
    }
    rowCounter += 1;
  };

  // Emit a single full-width banner cell. Height is derived from its aspect so
  // it keeps proportion across the full width.
  const emitFullWidth = (item: LayoutInput) => {
    cells.push({
      key: item.key,
      width: containerWidth,
      height: containerWidth / aspectOf(item),
      fullWidth: true,
      row: rowCounter,
    });
    rowCounter += 1;
  };

  // Pack a flat list of items into justified rows of up to `rowOf` each.
  const emitJustifiedRows = (list: LayoutInput[]) => {
    for (let i = 0; i < list.length; i += rowOf) {
      emitRow(list.slice(i, i + rowOf));
    }
  };

  for (let start = 0; start < items.length; start += segmentSize) {
    const segment = items.slice(start, start + segmentSize);
    const isFullSegment = segment.length === segmentSize;

    if (isFullSegment) {
      const gridItems = segment.slice(0, segmentSize - 1); // first 4
      const last = segment[segmentSize - 1]; // 5th
      const lastIsLandscape = aspectOf(last) >= fullWidthMinAspect;

      if (lastIsLandscape) {
        // 4 items in justified rows, then the 5th as a full-width banner.
        emitJustifiedRows(gridItems);
        emitFullWidth(last);
      } else {
        // 5th demoted: flow all 5 through justified rows (2 + 2 + 1, last row
        // scaled to fill width so it isn't ragged).
        emitJustifiedRows(segment);
      }
    } else {
      // Trailing partial segment: justified rows filling the width.
      emitJustifiedRows(segment);
    }
  }

  return cells;
}
