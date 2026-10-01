// GET /api/admin/media/[media_id]/history
//
// Retrieve moderation history for a media item with audit trail details.
//
// Task 3.5: Create GET endpoint for moderation history
// Requirements: 4.3, 4.4, 5.3
//
// This endpoint allows administrators to:
//  - View complete chronological history of hide/unhide actions for a media item
//  - See which admin performed each action and when
//  - Review moderation reasons provided when hiding media
//
// The endpoint returns moderation log entries ordered chronologically (newest first)
// with admin usernames joined from the users table.

import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { verifyRequest, requireAdmin } from '@/lib/auth';
import { ModerationLogEntry } from '@/app/dto/admin-media';

interface ModerationHistoryResponse {
    media_id: number;
    history: ModerationLogEntry[];
}

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ media_id: string }> }
): Promise<Response> {
    // 1. Verify admin authentication (Requirement 4.3, 4.4)
    const auth = verifyRequest(request);
    const errorResponse = requireAdmin(auth);
    if (errorResponse) {
        return errorResponse;
    }

    // Type narrowing: since requireAdmin returned null, auth must be the success case
    if (!auth.ok) {
        throw new Error('Unreachable: requireAdmin should have returned an error');
    }

    const { media_id } = await params;
    const mediaId = parseInt(media_id, 10);

    // Validate media_id is a valid number
    if (isNaN(mediaId)) {
        return new Response(
            JSON.stringify({ error: 'Invalid media_id: must be a number' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
    }

    // 2. Query moderation_log with admin usernames (Requirement 4.4, 5.3)
    try {
        // First check if the media item exists
        const mediaCheck = await pool.query(
            'SELECT media_id FROM media WHERE media_id = $1',
            [mediaId]
        );

        if (mediaCheck.rows.length === 0) {
            return new Response(
                JSON.stringify({ error: 'Media not found' }),
                { status: 404, headers: { 'Content-Type': 'application/json' } }
            );
        }

        // Query moderation history with admin usernames
        // JOIN with users table to get admin_username
        // ORDER BY created_at DESC for chronological order (newest first)
        const result = await pool.query(
            `SELECT 
                ml.log_id,
                ml.admin_id,
                u.username as admin_username,
                ml.action,
                ml.reason,
                ml.created_at
             FROM media_moderation_log ml
             JOIN users u ON ml.admin_id = u.user_id
             WHERE ml.media_id = $1
             ORDER BY ml.created_at DESC`,
            [mediaId]
        );

        // 3. Return chronological history with action details (Requirement 4.3, 4.4, 5.3)
        const history: ModerationLogEntry[] = result.rows.map(row => ({
            log_id: row.log_id,
            media_id: mediaId,
            admin_id: row.admin_id,
            admin_username: row.admin_username,
            action: row.action as 'hide' | 'unhide',
            reason: row.reason,
            created_at: row.created_at.toISOString()
        }));

        const response: ModerationHistoryResponse = {
            media_id: mediaId,
            history
        };

        return new Response(
            JSON.stringify(response),
            {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    } catch (error) {
        console.error('Error fetching moderation history:', error);
        return new Response(
            JSON.stringify({ error: 'Internal server error' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
}
