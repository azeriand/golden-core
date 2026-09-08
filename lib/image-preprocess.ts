// lib/image-preprocess.ts
//
// Client-side image preprocessing (Task 7.1, design Component 4).
//
// Compresses/resizes images in the browser using the Canvas API *before* they
// are uploaded directly to Vercel Blob. This module is CLIENT-ONLY and must be
// safe to import from a client component:
//   - It uses ONLY browser APIs (`createImageBitmap`, `HTMLCanvasElement` /
//     `OffscreenCanvas`, `canvas.toBlob` / `OffscreenCanvas.convertToBlob`).
//   - It references NO server-only module (no `lib/db`, no `@vercel/blob`, no
//     `process.env`, and never `BLOB_READ_WRITE_TOKEN`).
//   - It does NOT declare `"use server"`.
//   - Every browser API is feature-detected so importing/calling this module in
//     a non-browser (SSR/build) environment degrades gracefully by returning the
//     original file untouched instead of throwing.
//
// Design behavior (Requirements 5.1-5.8, correctness property P6):
//   - Videos and non-images are returned byte-identical (never decoded/encoded).
//   - Images below `minSkipBytes` are returned untouched (avoid needless
//     re-encode / quality loss).
//   - Otherwise the image is drawn onto a canvas capped at `maxEdge`x`maxEdge`
//     preserving aspect ratio, with EXIF orientation baked into the pixels via
//     `createImageBitmap(file, { imageOrientation: 'from-image' })`, then encoded
//     via `canvas.toBlob(type, quality)` at ~`quality` (default 0.8).
//   - Never enlarges: if the produced blob is not smaller than the input, the
//     original file is returned untouched.
//   - The input `File` is never mutated.
//   - ANY preprocessing failure (decode error, null blob, canvas unavailable)
//     results in the ORIGINAL file being returned untouched with
//     `processed: false` — a preprocessing failure must never corrupt or lose the
//     original file.

import { encode as encodeBlurhash } from 'blurhash';

export interface PreprocessResult {
    blob: Blob; // processed output, or the original file when skipped/failed
    processed: boolean; // false when the original was returned untouched
    width: number; // output width in pixels (0 when unknown)
    height: number; // output height in pixels (0 when unknown)
    /**
     * Client-computed BlurHash for the image, or null. NON-BLOCKING: it is
     * derived from the SAME decoded pixels used for compression on a tiny
     * downscaled sample, wrapped in try/catch so ANY failure yields null and the
     * upload proceeds normally. It is null for videos, non-images, skipped
     * images, and any input that did not reach the decode step (Req 9, design
     * client-BlurHash amendment). BlurHash generation NEVER throws.
     */
    blurhash: string | null;
}

export interface PreprocessOptions {
    maxEdge?: number; // default 2000; both output dimensions are clamped to <= this
    quality?: number; // default 0.8; encoder quality (0 < quality <= 1)
    minSkipBytes?: number; // default ~200KB; images smaller than this are skipped
}

const DEFAULT_MAX_EDGE = 2000;
const DEFAULT_QUALITY = 0.8;
const DEFAULT_MIN_SKIP_BYTES = 200 * 1024; // ~200KB

// BlurHash generation sample + component counts (matches the server-side
// lib/blurhash.ts: a 32x32 sample encoded at 4x3 components) so client- and
// server-generated hashes decode to visually consistent placeholders.
const BLURHASH_SAMPLE_EDGE = 32;
const BLURHASH_COMPONENTS_X = 4;
const BLURHASH_COMPONENTS_Y = 3;

// Canvas encoders reliably support these output MIME types. Anything else
// (image/heic, image/heif, image/tiff, image/bmp, image/gif, empty, ...) is not
// guaranteed to be encodable by `toBlob`, so we fall back to JPEG to guarantee a
// VALID image result. This is consistent with the app's image classification in
// the legacy media route and the upload-token handshake (`file.type` starts with
// `image/`).
const CANVAS_ENCODABLE_MIME_TYPES = new Set<string>([
    'image/jpeg',
    'image/png',
    'image/webp',
]);
const FALLBACK_MIME_TYPE = 'image/jpeg';

/** True only for files whose content type marks them as an image (Req 5.6/5.8). */
function isImageFile(file: File): boolean {
    return typeof file.type === 'string' && file.type.startsWith('image/');
}

/**
 * Choose the output MIME type: preserve the source type when the canvas can
 * reliably encode it, otherwise fall back to a valid JPEG (documented above).
 */
function chooseOutputMimeType(sourceType: string): string {
    return CANVAS_ENCODABLE_MIME_TYPES.has(sourceType) ? sourceType : FALLBACK_MIME_TYPE;
}

/** Build the untouched-original result (skip / failure paths). */
function original(file: File, width = 0, height = 0): PreprocessResult {
    // Skip / failure paths never compute a BlurHash (videos, non-images, small
    // images, decode failures) — blurhash is null and the upload proceeds.
    return { blob: file, processed: false, width, height, blurhash: null };
}

/**
 * Compute a BlurHash from an already-decoded ImageBitmap on a tiny downscaled
 * sample canvas (BLURHASH_SAMPLE_EDGE), independent of the encode canvas.
 *
 * NON-BLOCKING CONTRACT (Req 9 / design client-BlurHash amendment): this NEVER
 * throws. Any failure — no canvas/2d context, getImageData failure (e.g. a
 * tainted canvas), or the encoder throwing — is caught and returns null so the
 * caller keeps `blurhash: null` and the upload is unaffected. The sample is
 * scaled to preserve aspect ratio within a BLURHASH_SAMPLE_EDGE box so the hash
 * reflects the image proportions.
 */
function computeBlurhash(bitmap: ImageBitmap): string | null {
    try {
        const srcWidth = bitmap.width;
        const srcHeight = bitmap.height;
        if (srcWidth <= 0 || srcHeight <= 0) return null;

        const { width: sampleWidth, height: sampleHeight } = fitWithin(
            srcWidth,
            srcHeight,
            BLURHASH_SAMPLE_EDGE,
        );
        if (sampleWidth <= 0 || sampleHeight <= 0) return null;

        // Draw the bitmap onto a small sample canvas and read its RGBA pixels.
        // Prefer OffscreenCanvas (worker-safe); fall back to HTMLCanvasElement.
        let imageData: ImageData | null = null;

        if (typeof OffscreenCanvas === 'function') {
            const canvas = new OffscreenCanvas(sampleWidth, sampleHeight);
            const ctx = canvas.getContext('2d');
            if (!ctx) return null;
            ctx.drawImage(bitmap, 0, 0, sampleWidth, sampleHeight);
            imageData = ctx.getImageData(0, 0, sampleWidth, sampleHeight);
        } else if (
            typeof document !== 'undefined' &&
            typeof document.createElement === 'function'
        ) {
            const canvas = document.createElement('canvas');
            canvas.width = sampleWidth;
            canvas.height = sampleHeight;
            const ctx = canvas.getContext('2d');
            if (!ctx) return null;
            ctx.drawImage(bitmap, 0, 0, sampleWidth, sampleHeight);
            imageData = ctx.getImageData(0, 0, sampleWidth, sampleHeight);
        }

        if (!imageData) return null;

        return encodeBlurhash(
            imageData.data,
            imageData.width,
            imageData.height,
            BLURHASH_COMPONENTS_X,
            BLURHASH_COMPONENTS_Y,
        );
    } catch {
        // Any failure -> null. Never throws; the upload proceeds normally.
        return null;
    }
}

/**
 * Are the browser APIs this module needs available? Feature-detected so the
 * module is safe to import from a client component and degrades gracefully in
 * SSR/build/worker environments that lack a canvas (Req 5.x graceful failure).
 */
function canPreprocess(): boolean {
    return (
        typeof createImageBitmap === 'function' &&
        (typeof OffscreenCanvas === 'function' ||
            (typeof document !== 'undefined' &&
                typeof document.createElement === 'function'))
    );
}

/** Compute target dimensions preserving aspect ratio so neither exceeds maxEdge. */
function fitWithin(
    width: number,
    height: number,
    maxEdge: number,
): { width: number; height: number } {
    if (width <= 0 || height <= 0) return { width, height };
    const longest = Math.max(width, height);
    if (longest <= maxEdge) return { width, height };
    const scale = maxEdge / longest;
    // Round and clamp to at least 1px; clamp to maxEdge to defend against any
    // floating-point rounding pushing a dimension to maxEdge + 1.
    return {
        width: Math.min(maxEdge, Math.max(1, Math.round(width * scale))),
        height: Math.min(maxEdge, Math.max(1, Math.round(height * scale))),
    };
}

/**
 * Draw the bitmap onto a target-sized canvas and encode it to a Blob.
 * Prefers OffscreenCanvas (works off the main thread / in workers) and falls
 * back to an HTMLCanvasElement. Returns null on any encode failure so the caller
 * can safely fall back to the original file.
 */
async function drawAndEncode(
    bitmap: ImageBitmap,
    targetWidth: number,
    targetHeight: number,
    mimeType: string,
    quality: number,
): Promise<Blob | null> {
    // Preferred path: OffscreenCanvas + convertToBlob.
    if (typeof OffscreenCanvas === 'function') {
        const canvas = new OffscreenCanvas(targetWidth, targetHeight);
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
        try {
            return await canvas.convertToBlob({ type: mimeType, quality });
        } catch {
            return null;
        }
    }

    // Fallback path: HTMLCanvasElement + toBlob.
    if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
        const canvas = document.createElement('canvas');
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
        return await new Promise<Blob | null>((resolve) => {
            // toBlob invokes the callback with `null` if the type is unsupported
            // or encoding fails; the caller treats null as "keep original".
            canvas.toBlob((blob) => resolve(blob), mimeType, quality);
        });
    }

    return null;
}

/**
 * Preprocess a single image `File` for upload. See the module header for the
 * full contract. Never mutates `file`; never throws for the expected failure
 * modes (returns the original untouched instead).
 *
 * Preconditions: `maxEdge > 0`, `0 < quality <= 1` (invalid options are coerced
 * to defaults so the function still degrades gracefully rather than throwing).
 */
export async function preprocessImage(
    file: File,
    opts?: PreprocessOptions,
): Promise<PreprocessResult> {
    // Resolve + sanitize options (coerce out-of-range values to defaults).
    const maxEdge =
        opts?.maxEdge != null && opts.maxEdge > 0 ? opts.maxEdge : DEFAULT_MAX_EDGE;
    const quality =
        opts?.quality != null && opts.quality > 0 && opts.quality <= 1
            ? opts.quality
            : DEFAULT_QUALITY;
    const minSkipBytes =
        opts?.minSkipBytes != null && opts.minSkipBytes >= 0
            ? opts.minSkipBytes
            : DEFAULT_MIN_SKIP_BYTES;

    // 1. Non-images (videos, anything without an `image/*` type) are returned
    //    byte-identical. We never decode or compress them (Req 5.5/5.6/5.8, P6).
    if (!isImageFile(file)) {
        return original(file);
    }

    // 2. Small images are returned untouched to avoid needless quality loss
    //    (Req 5.4).
    if (file.size < minSkipBytes) {
        return original(file);
    }

    // 3. If the required browser APIs are unavailable, fail gracefully by
    //    returning the original untouched (Req 5.x graceful failure).
    if (!canPreprocess()) {
        return original(file);
    }

    let bitmap: ImageBitmap | null = null;
    try {
        // Decode with EXIF orientation applied. `imageOrientation: 'from-image'`
        // tells the decoder to honor the file's EXIF Orientation tag and produce
        // an ImageBitmap whose pixels are already rotated/flipped accordingly, so
        // the orientation is baked into the drawn canvas output and the encoded
        // blob carries no EXIF at all yet still looks correctly oriented
        // (Req 5.3).
        bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });

        const srcWidth = bitmap.width;
        const srcHeight = bitmap.height;
        if (srcWidth <= 0 || srcHeight <= 0) {
            // Degenerate decode — keep the original.
            return original(file);
        }

        // Compute the client BlurHash from the SAME decoded pixels (Req 9,
        // design client-BlurHash amendment). Non-blocking: computeBlurhash never
        // throws; a null result just means no placeholder is sent. Computed once
        // here so every image return path below (processed, never-enlarge,
        // encode-failure) can carry it.
        const blurhash = computeBlurhash(bitmap);

        // 4. Compute target dimensions preserving aspect ratio (Req 5.1).
        const { width: targetWidth, height: targetHeight } = fitWithin(
            srcWidth,
            srcHeight,
            maxEdge,
        );

        // 5. Draw + encode at ~quality (Req 5.2). Preserve source MIME when the
        //    canvas can reliably encode it; otherwise fall back to JPEG.
        const outputType = chooseOutputMimeType(file.type);
        const encoded = await drawAndEncode(
            bitmap,
            targetWidth,
            targetHeight,
            outputType,
            quality,
        );

        // 6. Encode failure (null) => keep original untouched, but still carry
        //    the BlurHash we already computed (the original bytes are uploaded).
        if (!encoded) {
            return { blob: file, processed: false, width: srcWidth, height: srcHeight, blurhash };
        }

        // 7. Never enlarge / never bloat (Req 5.7): if the output is not smaller
        //    than the input, discard it and keep the original — still carrying
        //    the BlurHash so the placeholder renders on reload.
        if (encoded.size >= file.size) {
            return { blob: file, processed: false, width: srcWidth, height: srcHeight, blurhash };
        }

        return {
            blob: encoded,
            processed: true,
            width: targetWidth,
            height: targetHeight,
            blurhash,
        };
    } catch {
        // ANY failure (decode error, canvas error, unexpected exception) must not
        // corrupt or lose the original file — return it untouched (Req 5.x).
        return original(file);
    } finally {
        // Release decoded bitmap resources; never touches the input File.
        if (bitmap && typeof bitmap.close === 'function') {
            bitmap.close();
        }
    }
}
