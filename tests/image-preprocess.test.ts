// Unit tests for `preprocessImage` (lib/image-preprocess.ts) — Task 13.2.
//
// The module's REAL decision logic is exercised (isImageFile, fitWithin/maxEdge
// math, never-enlarge comparison, skip threshold, MIME fallback, try/catch
// fallback, original preservation). ONLY the browser boundary is mocked:
//   - `createImageBitmap` -> a fake ImageBitmap with controllable width/height
//     and a spied `close()`; we also assert it is called with
//     `{ imageOrientation: 'from-image' }` (unit-level orientation assertion —
//     real pixel orientation cannot be verified without a real decoder).
//   - `OffscreenCanvas` -> a fake exposing getContext('2d').drawImage and
//     convertToBlob returning a Blob of a controllable size/type.
// No jsdom is needed: node env + vi.stubGlobal is sufficient because the module
// prefers OffscreenCanvas and never touches `document` on this path.
//
// These are UNIT tests (specific examples/edge cases). The byte-identity
// PROPERTY (P6) for arbitrary video/non-image inputs belongs to task 13.5.
//
// Covered acceptance criteria: Req 5.1 (max-edge clamp), 5.2 (quality passed),
// 5.3 (orientation via createImageBitmap args), 5.4 (small-image skip),
// 5.5/5.6/5.8 (video/non-image untouched), 5.7 (never enlarge).
import {
    describe,
    it,
    expect,
    vi,
    beforeEach,
    afterEach,
} from 'vitest';
import { preprocessImage } from '@/lib/image-preprocess';
import { decode as decodeBlurhash } from 'blurhash';

// --- Fakes for the browser boundary ------------------------------------------

interface DrawCall {
    width: number;
    height: number;
}

let createImageBitmapMock: ReturnType<typeof vi.fn>;
let convertToBlobMock: ReturnType<typeof vi.fn>;
let drawImageCalls: DrawCall[];
let bitmapClose: ReturnType<typeof vi.fn>;

// Controls for the current test.
let bitmapWidth = 4000;
let bitmapHeight = 3000;
let outputBlobSize = 1000; // bytes the fake encoder produces
let convertShouldThrow = false;
let getImageDataThrows = false; // forces BlurHash graceful-null path

function installBrowserStubs(): void {
    drawImageCalls = [];
    bitmapClose = vi.fn();

    createImageBitmapMock = vi.fn(async () => ({
        width: bitmapWidth,
        height: bitmapHeight,
        close: bitmapClose,
    }));

    convertToBlobMock = vi.fn(async (opts: { type: string; quality: number }) => {
        if (convertShouldThrow) throw new Error('encode failed');
        // The fake honors the requested type so we can assert MIME fallback.
        return new Blob([new Uint8Array(outputBlobSize)], { type: opts.type });
    });

    class FakeOffscreenCanvas {
        width: number;
        height: number;
        // Draw recorded for THIS canvas; flushed to drawImageCalls only on the
        // ENCODE path (convertToBlob), so the BlurHash sample canvas (which uses
        // getImageData, never convertToBlob) never pollutes drawImageCalls.
        lastDraw: { width: number; height: number } | null = null;
        constructor(w: number, h: number) {
            this.width = w;
            this.height = h;
        }
        // Class-field arrow method binds `this` lexically at construction (no
        // `this` aliasing), so the returned context object closes over the
        // instance cleanly.
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
                // Used by the BlurHash sample canvas. Controlled per test:
                // `getImageDataThrows` forces the graceful-null path; otherwise
                // returns a valid RGBA ImageData-like buffer for the requested
                // sample size so the real `blurhash` encoder produces a string.
                getImageData: (_x: number, _y: number, w: number, h: number) => {
                    if (getImageDataThrows) throw new Error('tainted canvas');
                    const data = new Uint8ClampedArray(w * h * 4);
                    // Simple non-uniform fill so the encoder has real signal.
                    for (let i = 0; i < data.length; i += 4) {
                        data[i] = (i * 7) & 0xff; // R
                        data[i + 1] = (i * 13) & 0xff; // G
                        data[i + 2] = (i * 29) & 0xff; // B
                        data[i + 3] = 255; // A (opaque)
                    }
                    return { data, width: w, height: h };
                },
            };
        };
        convertToBlob(opts: { type: string; quality: number }) {
            // Encode path: record THIS canvas's draw as the encode draw.
            if (this.lastDraw) drawImageCalls.push(this.lastDraw);
            return convertToBlobMock(opts);
        }
    }

    vi.stubGlobal('createImageBitmap', createImageBitmapMock);
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    // Ensure the HTMLCanvasElement fallback path is not accidentally taken.
    vi.stubGlobal('document', undefined);
}

/** Build a File with a controllable byte length + type. */
function makeFile(bytes: number, type: string, name = 'f'): File {
    return new File([new Uint8Array(bytes)], name, { type });
}

beforeEach(() => {
    // Reset per-test controls to sensible defaults.
    bitmapWidth = 4000;
    bitmapHeight = 3000;
    outputBlobSize = 1000;
    convertShouldThrow = false;
    getImageDataThrows = false;
    installBrowserStubs();
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('preprocessImage — passthrough (non-image / video)', () => {
    it('returns a video file byte-identically without touching the canvas', async () => {
        const file = makeFile(5_000_000, 'video/mp4', 'clip.mp4');
        const result = await preprocessImage(file);

        expect(result.processed).toBe(false);
        expect(result.blob).toBe(file); // same reference, byte-identical
        expect(createImageBitmapMock).not.toHaveBeenCalled();
    });

    it('returns a non-image (pdf) file untouched without decoding', async () => {
        const file = makeFile(3_000_000, 'application/pdf', 'doc.pdf');
        const result = await preprocessImage(file);

        expect(result.processed).toBe(false);
        expect(result.blob).toBe(file);
        expect(createImageBitmapMock).not.toHaveBeenCalled();
    });
});

describe('preprocessImage — small-image skip rule', () => {
    it('returns an image below minSkipBytes untouched', async () => {
        const file = makeFile(50 * 1024, 'image/jpeg'); // < default 200KB
        const result = await preprocessImage(file);

        expect(result.processed).toBe(false);
        expect(result.blob).toBe(file);
        expect(createImageBitmapMock).not.toHaveBeenCalled();
    });

    it('honors a custom minSkipBytes threshold', async () => {
        const file = makeFile(300 * 1024, 'image/jpeg');
        const result = await preprocessImage(file, { minSkipBytes: 1024 * 1024 });

        expect(result.processed).toBe(false);
        expect(result.blob).toBe(file);
    });
});

describe('preprocessImage — max-edge clamp preserving aspect ratio', () => {
    it('clamps the longest edge to maxEdge (default 2000) and preserves aspect ratio', async () => {
        bitmapWidth = 4000;
        bitmapHeight = 3000;
        outputBlobSize = 500; // ensure "smaller than input" so it is kept
        const file = makeFile(2_000_000, 'image/jpeg');

        const result = await preprocessImage(file);

        expect(result.processed).toBe(true);
        // 4000x3000 -> longest 4000 scaled to 2000 => 2000x1500.
        expect(result.width).toBe(2000);
        expect(result.height).toBe(1500);
        // The canvas was drawn at the clamped dimensions.
        expect(drawImageCalls).toHaveLength(1);
        expect(drawImageCalls[0]).toEqual({ width: 2000, height: 1500 });
    });

    it('clamps against a custom maxEdge', async () => {
        bitmapWidth = 1000;
        bitmapHeight = 2000; // portrait, longest = 2000
        outputBlobSize = 500;
        const file = makeFile(2_000_000, 'image/jpeg');

        const result = await preprocessImage(file, { maxEdge: 1000 });

        // longest 2000 scaled to 1000 => 500x1000.
        expect(result.width).toBe(500);
        expect(result.height).toBe(1000);
    });

    it('does not upscale a small-dimension image (dimensions preserved)', async () => {
        bitmapWidth = 800;
        bitmapHeight = 600; // both already under maxEdge
        outputBlobSize = 500;
        const file = makeFile(2_000_000, 'image/jpeg');

        const result = await preprocessImage(file);

        expect(result.width).toBe(800);
        expect(result.height).toBe(600);
        expect(drawImageCalls[0]).toEqual({ width: 800, height: 600 });
    });
});

describe('preprocessImage — orientation + quality passed to the boundary', () => {
    it('decodes with { imageOrientation: "from-image" }', async () => {
        outputBlobSize = 500;
        const file = makeFile(2_000_000, 'image/jpeg');

        await preprocessImage(file);

        expect(createImageBitmapMock).toHaveBeenCalledTimes(1);
        const [, options] = createImageBitmapMock.mock.calls[0];
        expect(options).toEqual({ imageOrientation: 'from-image' });
    });

    it('passes the configured quality to the encoder (default 0.8)', async () => {
        outputBlobSize = 500;
        const file = makeFile(2_000_000, 'image/jpeg');

        await preprocessImage(file);

        expect(convertToBlobMock).toHaveBeenCalledTimes(1);
        expect(convertToBlobMock.mock.calls[0][0].quality).toBeCloseTo(0.8);
    });

    it('passes a custom quality through to the encoder', async () => {
        outputBlobSize = 500;
        const file = makeFile(2_000_000, 'image/jpeg');

        await preprocessImage(file, { quality: 0.5 });

        expect(convertToBlobMock.mock.calls[0][0].quality).toBeCloseTo(0.5);
    });
});

describe('preprocessImage — successful compression result', () => {
    it('returns processed:true with the encoded (smaller) blob', async () => {
        outputBlobSize = 400_000; // smaller than 2_000_000 input
        const file = makeFile(2_000_000, 'image/jpeg');

        const result = await preprocessImage(file);

        expect(result.processed).toBe(true);
        expect(result.blob).not.toBe(file);
        expect(result.blob.size).toBe(400_000);
        expect(result.blob.type).toBe('image/jpeg');
        expect(bitmapClose).toHaveBeenCalled(); // resources released
    });
});

describe('preprocessImage — never-enlarge rule', () => {
    it('returns the original when the encoded blob is not smaller than input', async () => {
        outputBlobSize = 3_000_000; // larger than 2_000_000 input
        const file = makeFile(2_000_000, 'image/jpeg');

        const result = await preprocessImage(file);

        expect(result.processed).toBe(false);
        expect(result.blob).toBe(file);
    });

    it('returns the original when the encoded blob equals the input size', async () => {
        outputBlobSize = 2_000_000; // equal -> "not smaller" -> keep original
        const file = makeFile(2_000_000, 'image/jpeg');

        const result = await preprocessImage(file);

        expect(result.processed).toBe(false);
        expect(result.blob).toBe(file);
    });
});

describe('preprocessImage — MIME fallback', () => {
    it('falls back to image/jpeg for a non-canvas-encodable source (image/heic)', async () => {
        outputBlobSize = 400_000;
        const file = makeFile(2_000_000, 'image/heic');

        const result = await preprocessImage(file);

        expect(result.processed).toBe(true);
        // The encoder was asked for the JPEG fallback type.
        expect(convertToBlobMock.mock.calls[0][0].type).toBe('image/jpeg');
        expect(result.blob.type).toBe('image/jpeg');
    });

    it('preserves image/png for a canvas-encodable source', async () => {
        outputBlobSize = 400_000;
        const file = makeFile(2_000_000, 'image/png');

        const result = await preprocessImage(file);

        expect(convertToBlobMock.mock.calls[0][0].type).toBe('image/png');
        expect(result.blob.type).toBe('image/png');
    });
});

describe('preprocessImage — graceful failure', () => {
    it('returns the original untouched when createImageBitmap throws', async () => {
        createImageBitmapMock.mockRejectedValueOnce(new Error('decode boom'));
        const file = makeFile(2_000_000, 'image/jpeg');

        const result = await preprocessImage(file);

        expect(result.processed).toBe(false);
        expect(result.blob).toBe(file);
    });

    it('returns the original untouched when the encoder throws', async () => {
        convertShouldThrow = true;
        const file = makeFile(2_000_000, 'image/jpeg');

        const result = await preprocessImage(file);

        expect(result.processed).toBe(false);
        expect(result.blob).toBe(file);
    });

    it('returns the original when decoded dimensions are degenerate (0x0)', async () => {
        bitmapWidth = 0;
        bitmapHeight = 0;
        const file = makeFile(2_000_000, 'image/jpeg');

        const result = await preprocessImage(file);

        expect(result.processed).toBe(false);
        expect(result.blob).toBe(file);
    });
});

describe('preprocessImage — client BlurHash (Change 2)', () => {
    it('produces a decodable BlurHash string for a processed image', async () => {
        outputBlobSize = 400_000;
        const file = makeFile(2_000_000, 'image/jpeg');

        const result = await preprocessImage(file);

        expect(result.processed).toBe(true);
        expect(typeof result.blurhash).toBe('string');
        expect((result.blurhash as string).length).toBeGreaterThan(0);
        // The produced hash decodes without throwing (real blurhash package).
        const pixels = decodeBlurhash(result.blurhash as string, 32, 32);
        expect(pixels).toBeInstanceOf(Uint8ClampedArray);
        expect(pixels.length).toBe(32 * 32 * 4);
    });

    it('still produces a BlurHash on the never-enlarge path (original kept)', async () => {
        // Encoded output larger than input -> original kept, but the image was
        // decoded so a BlurHash is still available for the placeholder.
        outputBlobSize = 3_000_000;
        const file = makeFile(2_000_000, 'image/jpeg');

        const result = await preprocessImage(file);

        expect(result.processed).toBe(false);
        expect(result.blob).toBe(file);
        expect(typeof result.blurhash).toBe('string');
        expect((result.blurhash as string).length).toBeGreaterThan(0);
    });

    it('falls back to blurhash:null when getImageData throws (never throws)', async () => {
        outputBlobSize = 400_000;
        getImageDataThrows = true;
        installBrowserStubs(); // re-install with the throwing getImageData
        const file = makeFile(2_000_000, 'image/jpeg');

        // Must not throw; compression still succeeds; blurhash gracefully null.
        const result = await preprocessImage(file);

        expect(result.processed).toBe(true);
        expect(result.blurhash).toBeNull();
    });

    it('returns blurhash:null for a video (never decoded)', async () => {
        const file = makeFile(5_000_000, 'video/mp4', 'clip.mp4');
        const result = await preprocessImage(file);

        expect(result.processed).toBe(false);
        expect(result.blurhash).toBeNull();
        expect(createImageBitmapMock).not.toHaveBeenCalled();
    });

    it('returns blurhash:null for a non-image (pdf)', async () => {
        const file = makeFile(3_000_000, 'application/pdf', 'doc.pdf');
        const result = await preprocessImage(file);

        expect(result.processed).toBe(false);
        expect(result.blurhash).toBeNull();
    });

    it('returns blurhash:null for a below-threshold skipped image', async () => {
        const file = makeFile(50 * 1024, 'image/jpeg');
        const result = await preprocessImage(file);

        expect(result.processed).toBe(false);
        expect(result.blurhash).toBeNull();
    });

    it('returns blurhash:null when decode fails', async () => {
        createImageBitmapMock.mockRejectedValueOnce(new Error('decode boom'));
        const file = makeFile(2_000_000, 'image/jpeg');
        const result = await preprocessImage(file);

        expect(result.processed).toBe(false);
        expect(result.blurhash).toBeNull();
    });
});

describe('preprocessImage — input preservation', () => {
    it('never mutates the input File on the processed path', async () => {
        outputBlobSize = 400_000;
        const file = makeFile(2_000_000, 'image/jpeg', 'keep.jpg');
        const originalSize = file.size;
        const originalType = file.type;
        const originalName = file.name;

        await preprocessImage(file);

        expect(file.size).toBe(originalSize);
        expect(file.type).toBe(originalType);
        expect(file.name).toBe(originalName);
    });
});
