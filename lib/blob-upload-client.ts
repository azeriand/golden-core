// lib/blob-upload-client.ts
//
// Thin CLIENT-ONLY wrapper over `@vercel/blob/client` `upload()` (Task 7.2,
// design Component 6). Performs the direct-to-Blob transfer for a single file:
// the browser preprocesses images (Task 7.1), then uploads the resulting bytes
// straight to Vercel Blob using the official SDK. The server's only role in the
// byte path is the `upload-token` handshake (Task 3.1) referenced via
// `handleUploadUrl`.
//
// SECURITY / CLIENT-SAFETY:
//   - Imports ONLY from '@vercel/blob/client' (never the '@vercel/blob' server
//     entrypoint), so no server-only Blob code (put/head/del) is pulled in.
//   - Never references BLOB_READ_WRITE_TOKEN or any server env — the SDK fetches
//     a short-lived client token from the handshake route (Req 2.1/2.5, P5).
//   - Imports only the pure, dependency-free `lib/upload-path.ts` and the
//     client-only `lib/image-preprocess.ts`.
//   - Never imports the confirm route or calls confirm — this module returns all
//     the information the caller (upload.store) needs to confirm later.
//   - No token logging; no console debug residue (Req 18.5).
//
// PATHNAME CONTRACT (Task 3.1): @vercel/blob@2.3.1 does NOT let the server
// override the pathname the client passes to `upload()`. The handshake route
// recomputes the canonical pathname from the clientPayload and rejects with a
// 400 unless the client-supplied pathname matches exactly. We therefore build
// the pathname via the SHARED `buildCanonicalPathname` and send a clientPayload
// whose `filename` is the SAME value the server runs `safeBasename` on, so the
// server recomputes a byte-identical pathname.

import { upload } from '@vercel/blob/client';

import { buildCanonicalPathname } from '@/lib/upload-path';
import {
    preprocessImage,
    type PreprocessOptions,
} from '@/lib/image-preprocess';

/**
 * Arguments for a single direct-to-Blob upload attempt.
 *
 * `uploadId` is the client-generated UUID v4 correlation id (design D3). It is
 * used AS-IS for the entire attempt (never regenerated here) so retries and
 * reconciliation can dedupe by it (Req 7.1/7.2, 13.2).
 */
export interface BlobUploadArgs {
    /** The file the user selected. Images are preprocessed; videos/others are not. */
    file: File;
    /** Client-generated UUID v4 correlation id. Stable for the whole attempt. */
    uploadId: string;
    /** Event slug (route param + clientPayload; server validates they match). */
    eventSlug: string;
    /** Resolved numeric event id used to build the canonical Blob pathname. */
    eventId: number;
    /**
     * The enqueue-time ISO-8601 upload-intent date (Req 6.6). This is the SAME
     * immutable value that is (a) persisted in the IndexedDB queue record, (b)
     * sent by the same-session confirm body, and (c) reused by confirm-only
     * recovery after a reload. It is forwarded here into the handshake
     * clientPayload so the server can carry it in the signed tokenPayload and,
     * in `onUploadCompleted` reconciliation (production only), reconstruct the
     * `media.date` (a NOT NULL column) WITHOUT fabricating a date. It is never
     * a secret. The client generates it once at enqueue; this wrapper only
     * forwards it as-is.
     */
    date: string;
    /** Optional progress callback, reported as a whole/float 0-100 percentage. */
    onProgress?: (percentage: number) => void;
    /** Optional AbortSignal to cancel the in-flight upload. */
    signal?: AbortSignal;
    /** Optional image preprocessing options forwarded to preprocessImage. */
    preprocessOptions?: PreprocessOptions;
    /**
     * Optional client-side BlurHash, if one was already produced upstream. This
     * wrapper does NOT compute a BlurHash; it only passes through a value the
     * caller already has (otherwise null).
     */
    blurhash?: string | null;
}

/**
 * Everything the later confirm step needs. This wrapper NEVER calls confirm; it
 * returns this so the caller (upload.store) can build the ConfirmUploadBody.
 */
export interface BlobUploadResult {
    uploadId: string;
    /** Public URL of the uploaded blob (from PutBlobResult.url). */
    blobUrl: string;
    /** The canonical pathname sent to upload() (matches the server's contract). */
    pathname: string;
    /** Original filename (the value the server sanitizes with safeBasename). */
    filename: string;
    /** Final MIME of the ACTUAL bytes uploaded (post-preprocess for images). */
    contentType: string;
    /** Original file size in bytes. */
    originalSize: number;
    /** Size of the bytes actually uploaded (processed size for compressed images). */
    processedSize: number;
    /** True when the image was preprocessed and the processed bytes were uploaded. */
    processed: boolean;
    /** Pass-through BlurHash (null unless the caller supplied one). */
    blurhash: string | null;
}

/** True only for files whose content type marks them as an image (Req 5.6/5.8). */
function isImageFile(file: File): boolean {
    return typeof file.type === 'string' && file.type.startsWith('image/');
}

/**
 * Upload a single file directly to Vercel Blob via the client `upload()` helper.
 *
 * Flow:
 *  1. Use `args.uploadId` as-is for the whole attempt (never regenerated).
 *  2. Classify image vs video/other by MIME (`file.type.startsWith('image/')`),
 *     consistent with Task 7.1 and the server routes.
 *  3. Images: run `preprocessImage`. If `result.processed`, upload the processed
 *     blob; otherwise upload the ORIGINAL file. Videos/non-images are NEVER
 *     preprocessed — their original bytes are uploaded byte-for-byte.
 *  4. Derive the FINAL contentType from the ACTUAL bytes uploaded (processed =>
 *     processed blob's type; else file.type) and use it BOTH in the handshake
 *     clientPayload AND in the returned result (for confirm).
 *  5. Build the canonical pathname via the shared `buildCanonicalPathname`, and
 *     send `filename: file.name` in the clientPayload so the server recomputes
 *     an identical pathname (Task 3.1 contract). Also forward the enqueue-time
 *     `date` (Req 6.6) in the clientPayload so the server can thread it into the
 *     signed tokenPayload for onUploadCompleted reconciliation.
 *  6. Call `upload()` with multipart:true for ALL uploads (images + videos),
 *     wiring optional progress and cancellation.
 *
 * Errors (network, abort, server 4xx like pathname/content-type/size mismatch,
 * or demo 403) propagate to the caller — they are NEVER swallowed or converted
 * into a success (Req 18.x, P7). This wrapper does NOT call confirm.
 */
export async function uploadToBlob(
    args: BlobUploadArgs,
): Promise<BlobUploadResult> {
    const { file, uploadId, eventSlug, eventId, date, onProgress, signal } = args;

    // 2 + 3. Determine the body to upload. Videos/non-images are uploaded
    // byte-for-byte (the original File); images may be preprocessed.
    let bodyToUpload: Blob = file;
    let processed = false;
    // Client BlurHash produced by preprocessImage from the decoded image pixels
    // (Req 9). Non-blocking: preprocessImage returns null on any failure and for
    // videos/non-images/skipped images. We thread whatever it produced into the
    // result so confirm can persist it; if the caller ALSO supplied a blurhash
    // via args, the preprocess value takes precedence when present.
    let preprocessBlurhash: string | null = null;

    if (isImageFile(file)) {
        const pre = await preprocessImage(file, args.preprocessOptions);
        preprocessBlurhash = pre.blurhash;
        if (pre.processed) {
            bodyToUpload = pre.blob;
            processed = true;
        }
        // If not processed, preprocessImage returned the original file untouched.
    }

    // 4. Final contentType reflects the ACTUAL bytes being uploaded. When the
    // image was processed, preprocessImage may have fallen back to image/jpeg,
    // so the processed blob's own type is authoritative. Otherwise the original
    // file's type is used (videos and skipped images alike).
    const finalContentType = processed ? bodyToUpload.type : file.type;

    const originalSize = file.size;
    const processedSize = processed ? bodyToUpload.size : file.size;

    // 5. Build the server-controlled canonical pathname via the SHARED module so
    // it is byte-identical to what the handshake route recomputes. The
    // clientPayload.filename MUST be the same value the server runs safeBasename
    // on (file.name) so the recomputed pathname matches.
    const pathname = buildCanonicalPathname(eventId, uploadId, file.name);

    const clientPayload = JSON.stringify({
        uploadId,
        eventSlug,
        filename: file.name,
        contentType: finalContentType,
        size: bodyToUpload.size,
        // Enqueue-time upload-intent date (Req 6.6), forwarded so the server can
        // put it in the signed tokenPayload and reconstruct media.date during
        // onUploadCompleted reconciliation without fabricating a date. Not a secret.
        date,
    });

    // 6. Direct-to-Blob upload. multipart:true for ALL uploads gives automatic
    // parallel part upload + SDK-managed part retry within the single session
    // (Req 1.2, 11.1, 12.1). onUploadProgress and abortSignal are wired only
    // when provided.
    const result = await upload(pathname, bodyToUpload, {
        access: 'public',
        handleUploadUrl: `/api/event/${eventSlug}/media/upload-token`,
        clientPayload,
        multipart: true,
        contentType: finalContentType,
        // 7. Progress is optional. The SDK's callback receives an object shaped
        // { loaded: number; total: number; percentage: number } (verified from
        // @vercel/blob@2.3.1 UploadProgressEvent). The concrete type is not
        // re-exported from '@vercel/blob/client', so we annotate the param
        // inline to match. We forward only the percentage. Absent callback =>
        // undefined (no reject for missing callback).
        onUploadProgress: onProgress
            ? (event: { loaded: number; total: number; percentage: number }) =>
                  onProgress(event.percentage)
            : undefined,
        // 8. Cancellation: the SDK aborts the in-flight request when this signal
        // fires and rejects the upload() promise; we let that rejection
        // propagate (never catch-and-resolve-success).
        abortSignal: signal,
    });

    // 10. Return everything confirm needs. result.url is the public Blob URL.
    return {
        uploadId,
        blobUrl: result.url,
        pathname,
        filename: file.name,
        contentType: finalContentType,
        originalSize,
        processedSize,
        processed,
        // Prefer the client-computed BlurHash from preprocessing; fall back to
        // any caller-supplied value; else null. Videos/non-images never produce
        // one here (preprocessBlurhash stays null).
        blurhash: preprocessBlurhash ?? args.blurhash ?? null,
    };
}
