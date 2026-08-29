// lib/upload-path.ts
//
// Shared, pure, dependency-free Blob pathname sanitization (Task 7.2).
//
// The upload-token handshake route (Task 3.1) enforces a HARD CONTRACT: because
// @vercel/blob@2.3.1 does not let the server override the pathname the client
// passes to `upload()`, the server RE-COMPUTES the canonical pathname from the
// clientPayload and rejects the upload with a 400 ("pathname mismatch") unless
// the client-supplied pathname is byte-identical to:
//
//     events/${eventId}/${uploadId}/${safeBasename(filename)}
//
// To guarantee both sides compute the exact same value, this module is the
// single source of truth for that logic. It is CLIENT-SAFE:
//   - No server imports (no lib/db, no @vercel/blob, no process.env).
//   - No browser-only APIs either — pure string manipulation — so it is equally
//     importable from client and server code.
//   - No side effects.
//
// IMPORTANT: `safeBasename` below is a byte-for-byte reproduction of the inline
// `safeBasename` currently defined in the upload-token route. Do NOT change one
// without the other. A follow-up should dedupe the server's inline copy by
// importing this module (see Task 7.2 report).

/**
 * Sanitize a client-provided filename to a safe basename.
 *
 * Byte-for-byte identical to the inline `safeBasename` in the upload-token
 * route (app/api/event/[event-slug]/media/upload-token/route.ts):
 *   1. Take the last path segment only (defeats "../" and absolute paths).
 *   2. Replace every character outside [a-zA-Z0-9._-] with "_".
 *   3. Strip any leading dots.
 *   4. Fall back to "upload" when the result is empty.
 */
export function safeBasename(filename: string): string {
    // Take the last path segment only, defeating "../" and absolute paths.
    const base = filename.split(/[\\/]/).pop() ?? '';
    // Allow letters, digits, dot, dash, underscore; replace everything else.
    const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
    return cleaned.length > 0 ? cleaned : 'upload';
}

/**
 * Build the canonical, server-controlled Blob pathname for an upload.
 *
 * MUST match the server's `expectedPathname` in the upload-token route exactly:
 *   `events/${eventId}/${uploadId}/${safeBasename(filename)}`
 *
 * The client passes this exact value as the `pathname` argument to `upload()`;
 * the server recomputes it and rejects on any mismatch.
 */
export function buildCanonicalPathname(
    eventId: number,
    uploadId: string,
    filename: string,
): string {
    return `events/${eventId}/${uploadId}/${safeBasename(filename)}`;
}
