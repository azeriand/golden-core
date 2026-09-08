// Property test P6 — "Preprocess input byte immutability / preprocess safety"
// — Task 13.5.
//
// Property P6 (design.md / tasks.md, narrowed/broadened per the 13.5 brief):
//   The design's P6 states "Videos and non-images are byte-identical before and
//   after preprocessImage." Task 13.5 BROADENS this to the full INPUT
//   IMMUTABILITY contract from the design's preprocessImage spec ("Never mutates
//   `file`"): for EVERY generated input (image OR non-image/video), the ORIGINAL
//   input File's bytes MUST remain byte-for-byte identical after
//   `await preprocessImage(input, opts)` — on EVERY code path: passthrough
//   (original returned), successful transform (new smaller Blob returned),
//   never-enlarge (original kept), and graceful failure (decode/encode throws or
//   returns null → original kept).
//   Validates: Requirements 5.5, 5.6, 5.8 (and the design's "never mutates file"
//   postcondition on preprocessImage).
//
// HONESTY / verification boundary:
//   - The input-immutability assertion is RUNTIME-verified against the REAL
//     preprocessImage: we build a REAL `File` from fast-check-generated
//     high-entropy bytes, read the File's actual bytes via `arrayBuffer()`
//     BEFORE the call, run the real function, then read the File's bytes AGAIN
//     and compare byte-for-byte. Because the bytes are high-entropy, any
//     in-place write into the input's buffer (e.g. a future impl that calls
//     `file.arrayBuffer()` and mutates a shared ArrayBuffer, or reuses a mutable
//     buffer) would be DETECTED here.
//   - The REAL decision logic runs unmocked: isImageFile, small-image skip,
//     fitWithin/maxEdge clamp, never-enlarge compare, MIME choice/fallback, and
//     the try/catch graceful-failure fallback.
//   - Only the BROWSER DECODE/ENCODE BOUNDARY is mocked (Node has no real
//     canvas): `createImageBitmap`, `OffscreenCanvas`/getContext/drawImage/
//     convertToBlob, and `document = undefined` to force the OffscreenCanvas
//     path (exactly the 13.2 approach). Because decode/encode is faked, real
//     PIXEL transformation / output fidelity is NOT verified — that is out of
//     scope for P6, which is about the INPUT, not the output. The fake encoder
//     produces its OWN new Blob; its bytes are irrelevant to P6.
//
// This is a UNIT-level property (single-file, in-process). Real end-to-end
// browser canvas behavior is not exercised here.

import { describe, it, expect, vi, afterEach } from 'vitest';
import fc from 'fast-check';
import { preprocessImage } from '@/lib/image-preprocess';

// --- Browser-boundary fakes (per-run installable) ----------------------------
// Controls are held in a single mutable object so each async property execution
// installs a fresh configuration at its START (NOT beforeEach — fast-check runs
// many cases per `it`, so we reset inside the property body for isolation).

interface BoundaryControls {
    bitmapWidth: number;
    bitmapHeight: number;
    outputBlobSize: number;
    outputBlobType: string; // what the fake encoder stamps (mirrors requested type)
    // Failure injection for the graceful-failure path:
    bitmapShouldReject: boolean; // createImageBitmap rejects
    convertShouldThrow: boolean; // convertToBlob throws
    convertReturnsNull: boolean; // convertToBlob resolves null
}

let controls: BoundaryControls;

/** Install fresh browser-boundary stubs bound to the current `controls`. */
function installBrowserStubs(): void {
    const createImageBitmapMock = vi.fn(async () => {
        if (controls.bitmapShouldReject) {
            throw new Error('decode failed (injected)');
        }
        return {
            width: controls.bitmapWidth,
            height: controls.bitmapHeight,
            close: vi.fn(),
        };
    });

    const convertToBlobMock = vi.fn(
        async (opts: { type: string; quality: number }): Promise<Blob | null> => {
            if (controls.convertShouldThrow) throw new Error('encode failed (injected)');
            if (controls.convertReturnsNull) return null;
            // The fake encoder produces its OWN new Blob (bytes irrelevant to P6).
            // Honor the requested type so the real MIME-fallback logic is observable.
            return new Blob([new Uint8Array(controls.outputBlobSize)], {
                type: opts.type ?? controls.outputBlobType,
            });
        },
    );

    class FakeOffscreenCanvas {
        width: number;
        height: number;
        constructor(w: number, h: number) {
            this.width = w;
            this.height = h;
        }
        getContext(kind: string) {
            if (kind !== '2d') return null;
            return {
                drawImage: () => {
                    /* no-op: pixel transform is out of scope for P6 */
                },
            };
        }
        convertToBlob(opts: { type: string; quality: number }) {
            return convertToBlobMock(opts);
        }
    }

    vi.stubGlobal('createImageBitmap', createImageBitmapMock);
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    // Force the OffscreenCanvas path (never the HTMLCanvasElement fallback).
    vi.stubGlobal('document', undefined);
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

// --- Helpers -----------------------------------------------------------------

/** Read a File's ACTUAL stored bytes (not the source array). */
async function readBytes(file: File): Promise<Uint8Array> {
    return new Uint8Array(await file.arrayBuffer());
}

/** Byte-for-byte equality: same length AND every element identical. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    return Buffer.from(a).equals(Buffer.from(b));
}

// --- fast-check generators ----------------------------------------------------

// High-entropy, bounded bytes so accidental writes are observable but the
// property stays fast. Non-empty so a mutation always has something to corrupt.
const bytesArb = fc.uint8Array({ minLength: 16, maxLength: 4096 });

// Cover BOTH image and non-image/video types, AND canvas-encodable vs
// fallback-encodable image types.
const mimeArb = fc.constantFrom(
    // images — canvas-encodable (source type preserved by real logic)
    'image/jpeg',
    'image/png',
    'image/webp',
    // images — NOT canvas-encodable (real logic falls back to image/jpeg)
    'image/heic',
    'image/gif',
    // non-image / video / empty — passthrough (never decoded)
    'video/mp4',
    'video/webm',
    'application/pdf',
    '',
);

// Filenames (varied, some adversarial-ish) — must not affect byte immutability.
const filenameArb = fc.oneof(
    fc.stringMatching(/^[a-z0-9]{1,12}$/).map((s) => `${s || 'f'}.bin`),
    fc.constantFrom('a.jpg', 'clip.mp4', '../x.png', 'no-ext'),
);

// Decoder-reported dimensions: span below/at/above the maxEdge clamp so the
// real fitWithin / downscale / no-downscale branches all run.
const dimsArb = fc.record({
    width: fc.integer({ min: 1, max: 6000 }),
    height: fc.integer({ min: 1, max: 6000 }),
});

// Encoder output size: spans smaller-than-input (transform kept) and
// larger/equal (never-enlarge → original kept). Input bytes are <= 4096, so an
// output between 1 and 8000 straddles both sides of the never-enlarge boundary.
const outputSizeArb = fc.integer({ min: 1, max: 8000 });

// minSkipBytes: sometimes 0/1 (force processing on the tiny generated File so
// the transform/downscale/never-enlarge branches execute), sometimes the real
// default (~200KB) so image inputs hit the small-image SKIP passthrough.
const minSkipArb = fc.constantFrom(0, 1, 200 * 1024);

// maxEdge: sometimes tiny (force downscale), default 2000, or large (no clamp).
const maxEdgeArb = fc.constantFrom(100, 2000, 8000);

// A full generated case.
const caseArb = fc.record({
    bytes: bytesArb,
    mime: mimeArb,
    filename: filenameArb,
    dims: dimsArb,
    outputSize: outputSizeArb,
    minSkipBytes: minSkipArb,
    maxEdge: maxEdgeArb,
    quality: fc.constantFrom(0.5, 0.8, 1),
});

type GeneratedCase = {
    bytes: Uint8Array;
    mime: string;
    filename: string;
    dims: { width: number; height: number };
    outputSize: number;
    minSkipBytes: number;
    maxEdge: number;
    quality: number;
};

/** Reset boundary controls + install fresh stubs at the START of each run. */
function resetForRun(c: GeneratedCase): void {
    controls = {
        bitmapWidth: c.dims.width,
        bitmapHeight: c.dims.height,
        outputBlobSize: c.outputSize,
        outputBlobType: c.mime || 'image/jpeg',
        bitmapShouldReject: false,
        convertShouldThrow: false,
        convertReturnsNull: false,
    };
    installBrowserStubs();
}

const NUM_RUNS = 150;

describe('P6 — preprocessImage input byte immutability', () => {
    // ------------------------------------------------------------------
    // Property A — INPUT BYTES PRESERVED on the normal path (fakes succeed).
    // Across the full generated space (passthrough, downscale, transform,
    // never-enlarge), the REAL input File's bytes are unchanged after the call.
    // ------------------------------------------------------------------
    it('A: input File bytes are byte-for-byte identical after preprocessImage (normal paths)', async () => {
        await fc.assert(
            fc.asyncProperty(caseArb, async (c) => {
                resetForRun(c);

                // REAL File built from generated high-entropy bytes.
                const input = new File([c.bytes], c.filename, { type: c.mime });

                // Capture "before" from the CONSTRUCTED File (its real storage),
                // not from the generated array.
                const before = await readBytes(input);

                const result = await preprocessImage(input, {
                    maxEdge: c.maxEdge,
                    quality: c.quality,
                    minSkipBytes: c.minSkipBytes,
                });

                // Capture "after" again from the SAME File.
                const after = await readBytes(input);

                // CORE assertion: input bytes untouched.
                expect(after.length).toBe(before.length);
                expect(bytesEqual(after, before)).toBe(true);

                // Sanity on the OUTPUT contract (NOT output-byte equality):
                expect(typeof result.processed).toBe('boolean');
                expect(result.blob).toBeInstanceOf(Blob);
            }),
            { numRuns: NUM_RUNS },
        );
    });

    // ------------------------------------------------------------------
    // Property B — INPUT BYTES PRESERVED on the ERROR / FALLBACK path, AND the
    // real graceful-failure contract holds: the ORIGINAL File is returned
    // (identity) with processed:false.
    // ------------------------------------------------------------------
    it('B: on decode/encode failure, input bytes are preserved and the original file is returned untouched', async () => {
        // Only IMAGE inputs above the skip threshold actually reach the
        // decode/encode boundary, so constrain the generator to guarantee the
        // failure path is exercised.
        const imageMimeArb = fc.constantFrom(
            'image/jpeg',
            'image/png',
            'image/webp',
            'image/heic',
            'image/gif',
        );
        const failureModeArb = fc.constantFrom(
            'bitmap-reject',
            'convert-throw',
            'convert-null',
        );

        await fc.assert(
            fc.asyncProperty(
                fc.record({
                    bytes: bytesArb,
                    mime: imageMimeArb,
                    filename: filenameArb,
                    dims: dimsArb,
                    maxEdge: maxEdgeArb,
                    quality: fc.constantFrom(0.5, 0.8, 1),
                    failureMode: failureModeArb,
                }),
                async (c) => {
                    // Build a base case, then force processing (minSkipBytes 0) so
                    // the decode/encode boundary is guaranteed to be reached.
                    resetForRun({
                        bytes: c.bytes,
                        mime: c.mime,
                        filename: c.filename,
                        dims: c.dims,
                        outputSize: 1,
                        minSkipBytes: 0,
                        maxEdge: c.maxEdge,
                        quality: c.quality,
                    });
                    // Inject the chosen failure at the browser boundary.
                    if (c.failureMode === 'bitmap-reject') controls.bitmapShouldReject = true;
                    else if (c.failureMode === 'convert-throw') controls.convertShouldThrow = true;
                    else controls.convertReturnsNull = true;
                    // Re-install so the fakes observe the updated flags.
                    installBrowserStubs();

                    const input = new File([c.bytes], c.filename, { type: c.mime });
                    const before = await readBytes(input);

                    const result = await preprocessImage(input, {
                        maxEdge: c.maxEdge,
                        quality: c.quality,
                        minSkipBytes: 0,
                    });

                    const after = await readBytes(input);

                    // (i) input untouched
                    expect(bytesEqual(after, before)).toBe(true);
                    // (ii) real graceful-failure contract: ORIGINAL returned,
                    //      processed:false (asserted against the real impl).
                    expect(result.processed).toBe(false);
                    expect(result.blob).toBe(input);
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });

    // ------------------------------------------------------------------
    // Property C — PASSTHROUGH path pinned explicitly: for video / non-image /
    // below-threshold inputs, processed:false, blob is the ORIGINAL File
    // (identity), and input bytes unchanged.
    // ------------------------------------------------------------------
    it('C: passthrough inputs (video / non-image / below-threshold) return the original File with unchanged bytes', async () => {
        const passthroughArb = fc.oneof(
            // (1) video / non-image / empty type — always passthrough.
            fc.record({
                bytes: bytesArb,
                mime: fc.constantFrom('video/mp4', 'video/webm', 'application/pdf', ''),
                filename: filenameArb,
                minSkipBytes: minSkipArb,
            }),
            // (2) image BELOW the skip threshold (bytes <= 4096 < large threshold).
            fc.record({
                bytes: bytesArb,
                mime: fc.constantFrom('image/jpeg', 'image/png', 'image/heic'),
                filename: filenameArb,
                minSkipBytes: fc.constant(200 * 1024), // guarantees skip for tiny bytes
            }),
        );

        await fc.assert(
            fc.asyncProperty(passthroughArb, async (c) => {
                resetForRun({
                    bytes: c.bytes,
                    mime: c.mime,
                    filename: c.filename,
                    dims: { width: 4000, height: 3000 },
                    outputSize: 1,
                    minSkipBytes: c.minSkipBytes,
                    maxEdge: 2000,
                    quality: 0.8,
                });

                const input = new File([c.bytes], c.filename, { type: c.mime });
                const before = await readBytes(input);

                const result = await preprocessImage(input, {
                    minSkipBytes: c.minSkipBytes,
                });

                const after = await readBytes(input);

                expect(result.processed).toBe(false);
                expect(result.blob).toBe(input); // identity — original returned
                expect(bytesEqual(after, before)).toBe(true);
            }),
            { numRuns: NUM_RUNS },
        );
    });

    // ------------------------------------------------------------------
    // CONTROL CASE — prove the harness is NOT vacuous: a large, encodable image
    // with a small encoder output and minSkipBytes:0 DOES reach the transform
    // path (processed:true, new Blob) while STILL leaving input bytes untouched.
    // Guards against a false-passing P6 where nothing ever gets processed.
    // ------------------------------------------------------------------
    it('CONTROL: a processed image yields processed:true with a NEW blob, input bytes still untouched', async () => {
        controls = {
            bitmapWidth: 4000,
            bitmapHeight: 3000,
            outputBlobSize: 100, // << input, so the transform is kept
            outputBlobType: 'image/jpeg',
            bitmapShouldReject: false,
            convertShouldThrow: false,
            convertReturnsNull: false,
        };
        installBrowserStubs();

        const bytes = new Uint8Array(2048);
        for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 11) & 0xff;
        const input = new File([bytes], 'photo.jpg', { type: 'image/jpeg' });
        const before = await readBytes(input);

        const result = await preprocessImage(input, {
            maxEdge: 2000,
            quality: 0.8,
            minSkipBytes: 0,
        });

        const after = await readBytes(input);

        expect(result.processed).toBe(true);
        expect(result.blob).not.toBe(input);
        expect(result.blob.size).toBe(100);
        // 4000x3000 clamped to maxEdge 2000 -> 2000x1500.
        expect(result.width).toBe(2000);
        expect(result.height).toBe(1500);
        // Input still untouched.
        expect(bytesEqual(after, before)).toBe(true);
    });
});
