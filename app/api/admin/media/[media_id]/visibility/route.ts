// PATCH /api/admin/media/[media_id]/visibility
//
// Toggle media visibility (hide/unhide).

import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { verifyRequest, requireAdmin } from '@/lib/auth';

export async function PATCH(
    request: NextRequest,
    { params }: { params: Promise<{ media_id: string }> }
): Promise<Response> {
    const auth = verifyRequest(request);
    const errorResponse = requireAdmin(auth);
    if (errorResponse) return errorResponse;
    if (!auth.ok) throw new Error('Unreachable');

    const adminUserId = auth.user.userId;
    const { media_id } = await params;
    const mediaId = parseInt(media_id, 10);

    if (isNaN(mediaId)) {
        return new Response(
            JSON.stringify({ error: 'Invalid media_id' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
    }

    let body: { hidden: boolean };
    try {
        body = await request.json();
    } catch {
        return new Response(
            JSON.stringify({ error: 'Invalid JSON' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
    }

    if (typeof body.hidden !== 'boolean') {
        return new Response(
            JSON.stringify({ error: 'hidden must be boolean' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
    }

    try {
        const result = await pool.query(
            `UPDATE media
             SET is_hidden = $1,
                 hidden_at = CASE WHEN $1 = true THEN now() ELSE NULL END,
                 hidden_by = CASE WHEN $1 = true THEN $2 ELSE NULL END
             WHERE media_id = $3
             RETURNING media_id, is_hidden, hidden_at, hidden_by`,
            [body.hidden, adminUserId, mediaId]
        );

        if (result.rows.length === 0) {
            return new Response(
                JSON.stringify({ error: 'Media not found' }),
                { status: 404, headers: { 'Content-Type': 'application/json' } }
            );
        }

        const row = result.rows[0];
        return new Response(
            JSON.stringify({
                success: true,
                media_id: row.media_id,
                is_hidden: row.is_hidden,
                hidden_at: row.hidden_at,
                hidden_by: row.hidden_by,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        console.error('Error toggling media visibility:', error);
        return new Response(
            JSON.stringify({ error: 'Internal server error' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
}
