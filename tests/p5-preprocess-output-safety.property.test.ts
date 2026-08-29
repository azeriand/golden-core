// Property test P5 — "Preprocess output safety / bounds" — Task 13.6.
//
// NOTE ON P5 NAMING: design.md's P5 is "Token secrecy" (a bundle/response
// assertion). Per the 13.6 execution brief, this file instead covers the
// PREPROCESS OUTPUT-SAFETY property (the substance of Req 5.1-5.8) against the
// REAL preprocessImage; the token-secrecy bundle assertion is out of scope for
// this file and is handled by the security audit (13.8/13.9).
//
// Property P5 (preprocess output safety):
//   For arbitrary source dimensions, maxEdge, MIME, quality, minSkipBytes and
//   encoder output size, the REAL preprocessImage output is SAFE:
//     - processed:true  => both output dims <= maxEdge AND the output dims equal
//       the impl's OWN fitWithin computation (same rounding/clamp), aspect ratio
//       preserved by that formula; output dims <= source dims (never enlarged in
//       dimension); output.size < input.size (never enlarged in bytes);
//     - passthrough (video / non-image / empty / below-skip-threshold /
//       would-enlarge) => processed:false and blob === original File (identity);
//     - output MIME: canvas-encodable source preserved; non-encodable
//       (heic/heif/gif/tiff/bmp) => image/jpeg fallback (the encoder is ASKED for
//       that type AND the returned blob carries it);
//     - preprocessing failure (decode/encode throw or null) => processed:false,
//       original returned untouched.
//   Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8.
//
// The REAL decision logic runs unmocked (isImageFile, minSkipBytes skip,
// fitWithin/maxEdge clamp+rounding, chooseOutputMimeType, never-enlarge,
// graceful failure). ONLY the browser decode/encode boundary is faked (Node has
// no canvas): createImageBitmap, OffscreenCanvas/getContext/drawImage/
// convertToBlob, document=undefined — the same approach as 13.2/13.5. Real pixel
// transformation is NOT verified (out of scope); this property is about the
// output CONTRACT (dims/identity/MIME), not pixel fidelity.

import { describe, it, expect, vi, afterEach } from 'vitest';
import fc from 'fast-check';
import { preprocessImage } from '@/lib/image-preprocess';

// --- Browser-boundary fakes (per-run installable) ----------------------------

interface BoundaryControls {
    bitmapWidth: number;
    bitmapHeight: number;
    outputBlobSize: number;
    // Failure injection:
    bitmapShouldReject: boolean;
    convertShouldThrow: boolean;
    convertReturnsNull: boolean;
    // Records what MIME the encoder was asked for (assert fallback behaviour).
    requestedTypes: string[];
    drawCalls: Array<{ width: number; height: number }>;
}

let controls: BoundaryControls;

function installBrowserStubs(): void {
    const createImageBitmapMock = vi.fn(async () => {
        if (controls.bitmapShouldReject) throw new Error('decode failed (injected)');
        return {
            width: controls.bitmapWidth,
            height: controls.bitmapHeight,
            close: vi.fn(),
        };
    });

    const convertToBlobMock = vi.fn(
        async (opts: { type: string; quality: number }): Promise<Blob | null> => {
            controls.requestedTypes.push(opts.type);
            if (controls.convertShouldThrow) throw new Error('encode failed (injected)');
            if (controls.convertReturnsNull) return null;
            // Honor the requested type so the real MIME-fallback logic is observable.
            return new Blob([new Uint8Array(controls.outputBlobSize)], { type: opts.type });
        },
    );

    class FakeOffscreenCanvas {
        width: number;
        height: number;
        // The draw recorded for THIS canvas instance; flushed to
        // controls.drawCalls only when the ENCODE path (convertToBlob) runs.
        lastDraw: { width: number; height: number } | null = null;
        constructor(w: number, h: number) {
            this.width = w;
            this.height = h;
        }
        // Class-field arrow method binds `this` lexically (no `this` aliasing).
        getContext = (kind: string) => {
            if (kind !== '2d') return null;
            return {
                drawImage: (
                    _bitmap: unknown,
                    _x: number,
                    _y: number,
                    w: number,
                    h: number,
                ) => {
                    this.lastDraw = { width: w, height: h };
                },
                // The client BlurHash sampler (Change 2) draws onto a tiny sample
                // canvas and reads pixels via getImageData. Provide it so BlurHash
                // succeeds without throwing; those pixels are irrelevant to P5.
                // Crucially, a getImageData canvas is NOT flushed to drawCalls —
                // only convertToBlob (the encode path) flushes — so BlurHash
                // sampling never pollutes the bounds assertions even for tiny
                // (<=32px) images where size alone can't distinguish the canvases.
                getImageData: (_x: number, _y: number, w: number, h: number) => {
                    const data = new Uint8ClampedArray(Math.max(1, w) * Math.max(1, h) * 4);
                    return { data, width: w, height: h };
                },
            };
        };
        convertToBlob(opts: { type: string; quality: number }) {
            // Encode path: record THIS canvas's draw as the encode draw.
            if (this.lastDraw) controls.drawCalls.push(this.lastDraw);
            return convertToBlobMock(opts);
        }
    }

    vi.stubGlobal('createImageBitmap', createImageBitmapMock);
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    vi.stubGlobal('document', undefined); // force the OffscreenCanvas path
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

// --- Oracle: replicate the impl's EXACT fitWithin rounding/clamp -------------
// Mirrors lib/image-preprocess.ts `fitWithin` precisely so we assert the impl's
// INTENDED rounding, not an idealized formula.
function expectedFit(
    width: number,
    height: number,
    maxEdge: number,
): { width: number; height: number } {
    if (width <= 0 || height <= 0) return { width, height };
    const longest = Math.max(width, height);
    if (longest <= maxEdge) return { width, height };
    const scale = maxEdge / longest;
    return {
        width: Math.min(maxEdge, Math.max(1, Math.round(width * scale))),
        height: Math.min(maxEdge, Math.max(1, Math.round(height * scale))),
    };
}

// Canvas-encodable set mirrored from the impl.
const CANVAS_ENCODABLE = new Set(['image/jpeg', 'image/png', 'image/webp']);
const FALLBACK = 'image/jpeg';
function expectedOutputMime(sourceType: string): string {
    return CANVAS_ENCODABLE.has(sourceType) ? sourceType : FALLBACK;
}

function isImageType(type: string): boolean {
    return type.startsWith('image/');
}

// --- fast-check generators ----------------------------------------------------

const encodableImageArb = fc.constantFrom('image/jpeg', 'image/png', 'image/webp');
const fallbackImageArb = fc.constantFrom(
    'image/heic',
    'image/heif',
    'image/gif',
    'image/tiff',
    'image/bmp',
);
const nonImageArb = fc.constantFrom('video/mp4', 'video/webm', 'application/pdf', '');

const dimsArb = fc.record({
    width: fc.integer({ min: 1, max: 6000 }),
    height: fc.integer({ min: 1, max: 6000 }),
});

const maxEdgeArb = fc.constantFrom(100, 500, 2000, 8000);
const qualityArb = fc.constantFrom(0.5, 0.8, 1);

/** Build a File whose byte length is `size` and type is `mime`. */
function makeFile(size: number, mime: string, name = 'f'): File {
    return new File([new Uint8Array(size)], name, { type: mime });
}

function resetControls(over: Partial<BoundaryControls> = {}): void {
    controls = {
        bitmapWidth: 4000,
        bitmapHeight: 3000,
        outputBlobSize: 100,
        bitmapShouldReject: false,
        convertShouldThrow: false,
        convertReturnsNull: false,
        requestedTypes: [],
        drawCalls: [],
        ...over,
    };
    installBrowserStubs();
}

const NUM_RUNS = 150;

describe('P5 — preprocessImage output safety / bounds', () => {
    // ---------------------------------------------------------------------
    // A — PROCESSED path: output dims are the impl's exact fitWithin result,
    // both <= maxEdge and <= source dims; output.size < input.size; MIME per the
    // canvas-encodable/fallback rule.
    // ---------------------------------------------------------------------
    it('A: processed output is bounded, never-enlarged, and correctly typed', async () => {
        const processedArb = fc.record({
            mime: fc.oneof(encodableImageArb, fallbackImageArb),
            dims: dimsArb,
            maxEdge: maxEdgeArb,
            quality: qualityArb,
            // Input large enough to clear the skip threshold we pass (0).
            inputSize: fc.integer({ min: 1000, max: 5_000_000 }),
        });

        await fc.assert(
            fc.asyncProperty(processedArb, async (c) => {
                // Encoder output guaranteed strictly smaller than input so the
                // never-enlarge branch keeps the processed blob.
                const outputSize = Math.max(1, Math.floor(c.inputSize / 2));
                resetControls({
                    bitmapWidth: c.dims.width,
                    bitmapHeight: c.dims.height,
                    outputBlobSize: outputSize,
                });

                const input = makeFile(c.inputSize, c.mime);
                const result = await preprocessImage(input, {
                    maxEdge: c.maxEdge,
                    quality: c.quality,
                    minSkipBytes: 0,
                });

                // Must be processed on this branch.
                expect(result.processed).toBe(true);
                expect(result.blob).not.toBe(input);

                // Output dims equal the impl's OWN fitWithin computation.
                const exp = expectedFit(c.dims.width, c.dims.height, c.maxEdge);
                expect(result.width).toBe(exp.width);
                expect(result.height).toBe(exp.height);

                // Bounded by maxEdge.
                expect(result.width).toBeLessThanOrEqual(c.maxEdge);
                expect(result.height).toBeLessThanOrEqual(c.maxEdge);

                // Never enlarged in dimension (output <= source).
                expect(result.width).toBeLessThanOrEqual(c.dims.width);
                expect(result.height).toBeLessThanOrEqual(c.dims.height);

                // The canvas was drawn at exactly those dims.
                expect(controls.drawCalls).toHaveLength(1);
                expect(controls.drawCalls[0]).toEqual({ width: exp.width, height: exp.height });

                // Never enlarged in bytes (processed only kept when smaller).
                expect(result.blob.size).toBeLessThan(input.size);

                // MIME: canvas-encodable preserved; else JPEG fallback — both the
                // requested encoder type AND the returned blob type.
                const wantType = expectedOutputMime(c.mime);
                expect(controls.requestedTypes[0]).toBe(wantType);
                expect(result.blob.type).toBe(wantType);
            }),
            { numRuns: NUM_RUNS },
        );
    });

    // ---------------------------------------------------------------------
    // B — PASSTHROUGH: video / non-image / empty, OR image below the skip
    // threshold, OR a would-enlarge encode => processed:false, identity blob.
    // ---------------------------------------------------------------------
    it('B: passthrough inputs return the original File untouched (processed:false)', async () => {
        type Kind = 'non-image' | 'below-threshold' | 'would-enlarge';
        const passthroughArb = fc.record({
            kind: fc.constantFrom<Kind>('non-image', 'below-threshold', 'would-enlarge'),
            nonImageMime: nonImageArb,
            imageMime: fc.oneof(encodableImageArb, fallbackImageArb),
            dims: dimsArb,
            maxEdge: maxEdgeArb,
        });

        await fc.assert(
            fc.asyncProperty(passthroughArb, async (c) => {
                let input: File;
                let opts: { maxEdge?: number; minSkipBytes?: number } = {};

                if (c.kind === 'non-image') {
                    // Non-image / video / empty: never decoded regardless of size.
                    input = makeFile(3_000_000, c.nonImageMime, 'clip');
                    resetControls({ bitmapWidth: c.dims.width, bitmapHeight: c.dims.height });
                    opts = { maxEdge: c.maxEdge, minSkipBytes: 0 };
                } else if (c.kind === 'below-threshold') {
                    // Image below minSkipBytes: skipped untouched.
                    input = makeFile(50 * 1024, c.imageMime);
                    resetControls({ bitmapWidth: c.dims.width, bitmapHeight: c.dims.height });
                    opts = { maxEdge: c.maxEdge, minSkipBytes: 200 * 1024 };
                } else {
                    // would-enlarge: encoder output >= input, so original kept.
                    input = makeFile(1_000_000, c.imageMime);
                    resetControls({
                        bitmapWidth: c.dims.width,
                        bitmapHeight: c.dims.height,
                        outputBlobSize: 2_000_000, // >= input -> keep original
                    });
                    opts = { maxEdge: c.maxEdge, minSkipBytes: 0 };
                }

                const result = await preprocessImage(input, opts);

                expect(result.processed).toBe(false);
                expect(result.blob).toBe(input); // identity

                // Non-image/below-threshold never touch the decoder.
                if (c.kind === 'non-image' || c.kind === 'below-threshold') {
                    expect(controls.drawCalls).toHaveLength(0);
                    expect(controls.requestedTypes).toHaveLength(0);
                    // Sanity: these were indeed passthrough by classification.
                    if (c.kind === 'non-image') expect(isImageType(c.nonImageMime)).toBe(false);
                }
            }),
            { numRuns: NUM_RUNS },
        );
    });

    // ---------------------------------------------------------------------
    // C — FAILURE: decode/encode throw or null => processed:false, original
    // returned untouched (graceful no-op).
    // ---------------------------------------------------------------------
    it('C: decode/encode failure returns the original untouched (processed:false)', async () => {
        const failureArb = fc.record({
            mime: fc.oneof(encodableImageArb, fallbackImageArb),
            dims: dimsArb,
            maxEdge: maxEdgeArb,
            mode: fc.constantFrom('bitmap-reject', 'convert-throw', 'convert-null'),
        });

        await fc.assert(
            fc.asyncProperty(failureArb, async (c) => {
                resetControls({ bitmapWidth: c.dims.width, bitmapHeight: c.dims.height });
                if (c.mode === 'bitmap-reject') controls.bitmapShouldReject = true;
                else if (c.mode === 'convert-throw') controls.convertShouldThrow = true;
                else controls.convertReturnsNull = true;
                installBrowserStubs();

                const input = makeFile(2_000_000, c.mime);
                const result = await preprocessImage(input, {
                    maxEdge: c.maxEdge,
                    minSkipBytes: 0,
                });

                expect(result.processed).toBe(false);
                expect(result.blob).toBe(input); // identity — original untouched
            }),
            { numRuns: NUM_RUNS },
        );
    });
});
