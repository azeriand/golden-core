// Property test P17 — "Poster blob path is namespaced by media_id" — Task 9.5.
//
// Property 11 (design.md "Correctness Properties"):
//   For any media_id, the computed poster upload path is under
//   `posters/{media_id}/`.
//   Validates: Requirements 8.3, 8.6
//
// Why this property holds in process-job.ts:
//   `posterBlobPath(mediaId, extension)` returns the deterministic Blob
//   pathname for a media row's poster. Requirement 8.6 states each Poster_Image
//   is stored under a namespaced Vercel_Blob path derived from the associated
//   `media_id`; Requirement 8.3 uploads that poster to Blob. The path is built
//   as `posters/${mediaId}/poster.${extension}`, so the media_id is the sole
//   namespace segment directly beneath the `posters/` root. This guarantees:
//     - two distinct media ids never collide on the same key, and
//     - a re-run for the same media id overwrites the same key rather than
//       accumulating duplicates.
//
// This is a UNIT-level property against the REAL `posterBlobPath` exported by
// worker/src/process-job.ts. No boundaries are mocked — the function is pure
// (string in, string out), so fast-check exercises it directly over arbitrary
// positive-integer media ids and realistic image extensions.
//
// IMPORT NOTE: mirrors p14's relative import of the real worker module
// (`../worker/src/process-job`) so no new tsc errors are introduced.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { posterBlobPath } from '../worker/src/process-job';

// --- fast-check generators ----------------------------------------------------

// Positive-integer media ids: media_id is a serial/bigserial column, so ids are
// always >= 1 in the schema.
const mediaIdArb = fc.integer({ min: 1, max: 1_000_000_000 });

// Realistic poster image extensions the frame extractor may produce, plus a
// generic alphanumeric extension to widen the input space. The extension is
// orthogonal to the namespace property but is part of the real signature, so we
// vary it to prove the media_id namespace holds regardless of extension.
const extensionArb = fc.oneof(
    fc.constantFrom('jpg', 'jpeg', 'png', 'webp'),
    fc
        .string({ minLength: 1, maxLength: 5 })
        .filter((s) => /^[a-zA-Z0-9]+$/.test(s)),
);

const NUM_RUNS = 200;

describe('P17 — poster blob path is namespaced by media_id', () => {
    it('the computed path lives directly under posters/{media_id}/', () => {
        fc.assert(
            fc.property(mediaIdArb, extensionArb, (mediaId, extension) => {
                const path = posterBlobPath(mediaId, extension);

                // THE PROPERTY: the path is namespaced by media_id — it starts
                // with `posters/${mediaId}/` (Req 8.6) and therefore contains the
                // media_id namespace segment beneath the `posters/` root.
                const prefix = `posters/${mediaId}/`;
                expect(path.startsWith(prefix)).toBe(true);

                // The media_id namespace is the FIRST segment beneath `posters/`
                // (exactly `posters/{media_id}/...`), never nested elsewhere.
                const segments = path.split('/');
                expect(segments[0]).toBe('posters');
                expect(segments[1]).toBe(String(mediaId));
            }),
            { numRuns: NUM_RUNS },
        );
    });

    it('distinct media_ids never share a namespace prefix', () => {
        // Two different media ids must produce paths under different
        // `posters/{media_id}/` namespaces, so their posters can never collide.
        fc.assert(
            fc.property(
                mediaIdArb,
                mediaIdArb,
                extensionArb,
                (a, b, extension) => {
                    fc.pre(a !== b);
                    const pathA = posterBlobPath(a, extension);
                    const pathB = posterBlobPath(b, extension);

                    expect(pathA.startsWith(`posters/${a}/`)).toBe(true);
                    expect(pathB.startsWith(`posters/${b}/`)).toBe(true);
                    // Neither path falls under the other's media_id namespace.
                    expect(pathA.startsWith(`posters/${b}/`)).toBe(false);
                    expect(pathB.startsWith(`posters/${a}/`)).toBe(false);
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });

    it('the same media_id is deterministic across calls (stable overwrite key)', () => {
        // A re-run for the same media_id + extension must target the SAME key so
        // it overwrites rather than accumulating duplicates.
        fc.assert(
            fc.property(mediaIdArb, extensionArb, (mediaId, extension) => {
                expect(posterBlobPath(mediaId, extension)).toBe(
                    posterBlobPath(mediaId, extension),
                );
            }),
            { numRuns: NUM_RUNS },
        );
    });
});
