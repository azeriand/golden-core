// Property test P20 — "DTO exposes poster_url faithfully" — Task 13.3.
//
// Property 12 (design.md "Correctness Properties" / tasks.md):
//   For any media row, the DTO mapping (the Event_Endpoint GET and the
//   Confirm_Route `shapeMediaRow`) preserves the stored `poster_url` value
//   exactly, mapping a stored string to that same string and a NULL/absent
//   stored value to `null`.
//   Validates: Requirements 11.1, 11.2, 11.3, 11.4, 15.4
//
// Why replicate the mapping expression here:
//   The `poster_url` mapping is INLINE in both production paths and is not
//   exported as a standalone function, so — per the codebase's existing
//   convention for testing inline mapping logic — this test replicates the
//   EXACT expression used at each site and asserts its behavior:
//
//     Event_Endpoint (app/api/event/[event-slug]/route.ts):
//         const mediaItem: Media = { ..., poster_url: poster_url ?? null, ... };
//       where `poster_url` is destructured from the DB row
//       (`const { ..., poster_url, ... } = row;`). A NULL column arrives as
//       JS `null`; an absent column arrives as `undefined`; a text column
//       arrives as the stored string.
//
//     Confirm_Route.shapeMediaRow (.../media/confirm/route.ts):
//         poster_url: row.poster_url ?? null
//       where `row.poster_url?: string | null`.
//
//   Both sites use the SAME `?? null` coalescing, so a single model of that
//   expression captures both. The `Media` DTO type (app/dto/media.ts) declares
//   `poster_url: string | null`, so the mapping's output must be exactly that
//   shape (Req 11.1).
//
// Modeling approach (mirrors the in-memory-reference style of the other pN
//   tests): the "stored value" is generated across the full input space a
//   Postgres `text` column can surface into node-postgres — an arbitrary string
//   (including the empty string), JS `null` (a NULL column), and `undefined`
//   (an absent/unselected column) — and the mapping is applied verbatim, then
//   the output is asserted against the DTO contract.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { Media } from '@/app/dto/media';

// --- Verbatim replicas of the two inline mapping expressions ------------------
//
// Event_Endpoint: `poster_url` is a destructured row field, mapped via
//   `poster_url: poster_url ?? null`.
function mapEventEndpointPosterUrl(
    posterUrlColumn: string | null | undefined,
): string | null {
    // Exactly the expression used in the GET handler's Media item construction.
    return posterUrlColumn ?? null;
}

// Confirm_Route.shapeMediaRow: `poster_url: row.poster_url ?? null`.
function mapConfirmShapePosterUrl(row: {
    poster_url?: string | null;
}): string | null {
    // Exactly the expression used in shapeMediaRow's returned object.
    return row.poster_url ?? null;
}

// --- fast-check generators ----------------------------------------------------
//
// The full space of what a `text` column (media.poster_url) can surface into
// the JS layer via node-postgres:
//   - an arbitrary text value (the poster Blob URL, but any string is valid) —
//     INCLUDING the empty string, which must be preserved (NOT coalesced away),
//   - JS `null`   -> the column is SQL NULL ("no poster ready yet", Req 1.6),
//   - `undefined` -> the column was not present on the row object.
const storedStringArb = fc.oneof(
    fc.webUrl(), // realistic poster URL values
    fc.string(), // arbitrary strings, including edge shapes
    fc.constant(''), // empty string must be preserved verbatim
);

const storedValueArb: fc.Arbitrary<string | null | undefined> = fc.oneof(
    storedStringArb,
    fc.constant(null),
    fc.constant(undefined),
);

const mediaIdArb = fc.integer({ min: 1, max: 1_000_000 });

const NUM_RUNS = 200;

describe('P20 — DTO exposes poster_url faithfully', () => {
    it('event endpoint mapping preserves a stored string exactly and maps NULL/absent to null', () => {
        fc.assert(
            fc.property(storedValueArb, (stored) => {
                const mapped = mapEventEndpointPosterUrl(stored);

                if (typeof stored === 'string') {
                    // A stored string (including '') is preserved EXACTLY.
                    expect(mapped).toBe(stored);
                } else {
                    // SQL NULL (null) or an absent column (undefined) => null.
                    expect(mapped).toBeNull();
                }

                // Output always conforms to the DTO type: string | null.
                expect(mapped === null || typeof mapped === 'string').toBe(true);
            }),
            { numRuns: NUM_RUNS },
        );
    });

    it('confirm shapeMediaRow mapping preserves a stored string exactly and maps NULL/absent to null', () => {
        fc.assert(
            fc.property(storedValueArb, (stored) => {
                // shapeMediaRow reads `row.poster_url`; model both the present
                // and absent-key shapes the row can take.
                const row =
                    stored === undefined ? {} : { poster_url: stored };
                const mapped = mapConfirmShapePosterUrl(row);

                if (typeof stored === 'string') {
                    expect(mapped).toBe(stored);
                } else {
                    expect(mapped).toBeNull();
                }

                expect(mapped === null || typeof mapped === 'string').toBe(true);
            }),
            { numRuns: NUM_RUNS },
        );
    });

    it('both mapping sites agree for every stored value (single coalescing contract)', () => {
        // Requirements 11.2/11.3 (endpoint) and 11.4 (confirm response) require
        // newly created media to match the DTO shape the endpoint produces, so
        // the two sites must map identically for the same stored value.
        fc.assert(
            fc.property(storedValueArb, (stored) => {
                const viaEndpoint = mapEventEndpointPosterUrl(stored);
                const row = stored === undefined ? {} : { poster_url: stored };
                const viaConfirm = mapConfirmShapePosterUrl(row);

                expect(viaConfirm).toBe(viaEndpoint);
            }),
            { numRuns: NUM_RUNS },
        );
    });

    it('the mapped value sits in a well-typed Media DTO with the exact poster_url', () => {
        // End-to-end shape check: the mapping output drops into the `Media`
        // interface's `poster_url: string | null` field with no coercion, and a
        // stored NULL surfaces as `null` on the DTO item (Req 11.1, 11.3, 15.4).
        fc.assert(
            fc.property(mediaIdArb, storedValueArb, (mediaId, stored) => {
                const item: Media = {
                    media_id: mediaId,
                    user_id: 1,
                    content: 'https://blob.example/video.mp4',
                    type: 'video/mp4',
                    likes: 0,
                    liked: false,
                    date: '2024-01-01',
                    section_id: null,
                    blurhash: null,
                    username: null,
                    poster_url: mapEventEndpointPosterUrl(stored),
                };

                if (typeof stored === 'string') {
                    expect(item.poster_url).toBe(stored);
                } else {
                    // NULL column / absent column => null on the DTO (Req 11.3).
                    expect(item.poster_url).toBeNull();
                }
            }),
            { numRuns: NUM_RUNS },
        );
    });
});
