// DELETE /api/admin/media/[media_id]
//
// Force-delete a single media item as an admin, bypassing all FK constraints
// by explicitly cleaning up dependent rows first:
//   likes        → FK_likes_media_id (no CASCADE)
//   poster_jobs  → media_id FK (no CASCADE, added migration 004)
//   media_jobs   → media_id FK (no CASCADE, added migration 006)

import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { verifyRequest, requireAdmin } from '@/lib/auth';
import { del } from '@vercel/blob';

export async function DELETE(
    request: NextRequest,
    { params }: { params: Promise<{ media_id: string }> }
): Promise<Response> {
    const auth = verifyRequest(request);
    const errorResponse = requireAdmin(auth);
    if (errorResponse) return errorResponse;
    if (!auth.ok) throw new Error('Unreachable');

    const { media_id } = await params;
    const mediaId = parseInt(media_id, 10);

    if (isNaN(mediaId)) {
        return new Response(
            JSON.stringify({ error: 'Invalid media_id' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
    }

    try {
        // Fetch the media row first to get the blob URL and confirm it exists.
        // Admins can delete any media regardless of is_hidden or owner.
        const mediaResult = await pool.query(
            `SELECT media_id, content FROM media WHERE media_id = $1`,
            [mediaId]
        );

        if (mediaResult.rows.length === 0) {
            return new Response(
                JSON.stringify({ error: 'Media not found' }),
                { status: 404, headers: { 'Content-Type': 'application/json' } }
            );
        }

        const blobUrl: string | null = mediaResult.rows[0].content ?? null;

        // Remove all FK-dependent rows before deleting the media row itself.
        // Order doesn't matter between these three, but all must precede the
        // final DELETE FROM media.
        await pool.query(`DELETE FROM likes       WHERE media_id = $1`, [mediaId]);
        await pool.query(`DELETE FROM poster_jobs WHERE media_id = $1`, [mediaId]);
        await pool.query(`DELETE FROM media_jobs  WHERE media_id = $1`, [mediaId]);
        await pool.query(`DELETE FROM media        WHERE media_id = $1`, [mediaId]);

        // Delete the blob from Vercel Blob storage (best effort). The DB row is
        // already gone at this point, so a failure here produces an orphaned blob.
        // We log it with the ORPHANED_BLOBS marker so it can be reconciled later.
        if (blobUrl) {
            try {
                await del(blobUrl);
            } catch (blobError) {
                console.error('ORPHANED_BLOBS admin force-delete failed to remove blob', {
                    mediaId,
                    blobUrl,
                    message: blobError instanceof Error ? blobError.message : String(blobError),
                });
            }
        }

        return new Response(
            JSON.stringify({ success: true, deleted: mediaId }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        console.error('Error force-deleting media:', error);
        return new Response(
            JSON.stringify({ error: 'Internal server error' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
}
