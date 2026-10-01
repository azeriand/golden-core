// PATCH /api/admin/media/[media_id]/visibility
//
// Toggle media visibility (hide/unhide) with audit trail logging.
//
// Task 3.1: Create PATCH endpoint for toggling media visibility
// Requirements: 1.2, 1.3, 1.4, 1.5, 4.1, 4.2, 5.1, 5.2, 5.4, 6.1, 6.2, 6.3
//
// This endpoint allows administrators to:
//  - Hide inappropriate media from public view without deleting it
//  - Unhide previously hidden media
//  - Track who performed the action and when
//  - Optionally record a moderation reason (max 500 chars)
//
// The endpoint uses database transactions with row-level locking to ensure
// consistency when multiple administrators modify the same media item concurrently.

import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { verifyRequest, requireAdmin } from '@/lib/auth';

interface ToggleVisibilityRequest {
    hidden: boolean;
    reason?: string;
}

interface ToggleVisibilityResponse {
    success: true;
    media_id: number;
    is_hidden: boolean;
    hidden_at: string | null;
    hidden_by: number | null;
}

export async function PATCH(
    request: NextRequest,
    { params }: { params: Promise<{ media_id: string }> }
): Promise<Response> {
    // 1. Verify admin authentication
    const auth = verifyRequest(request);
    const errorResponse = requireAdmin(auth);
    if (errorResponse) {
        return errorResponse;
    }

    // At this point, auth.ok is true and auth.user.isAdmin is true
    // Type narrowing: since requireAdmin returned null, auth must be the success case
    if (!auth.ok) {
        throw new Error('Unreachable: requireAdmin should have returned an error');
    }
    
    const adminUserId = auth.user.userId;
    const { media_id } = await params;
    const mediaId = parseInt(media_id, 10);

    // Validate media_id is a valid number
    if (isNaN(mediaId)) {
        return new Response(
            JSON.stringify({ error: 'Invalid media_id: must be a number' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
    }

    // 2. Parse and validate request body
    let body: ToggleVisibilityRequest;
    try {
        body = await request.json();
    } catch {
        return new Response(
            JSON.stringify({ error: 'Invalid JSON in request body' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
    }

    // Validate required 'hidden' field
    if (typeof body.hidden !== 'boolean') {
        return new Response(
            JSON.stringify({ error: 'Invalid request: hidden must be boolean' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
    }

    // Validate optional 'reason' field length
    if (body.reason !== undefined) {
        if (typeof body.reason !== 'string') {
            return new Response(
                JSON.stringify({ error: 'Invalid request: reason must be a string' }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }
        if (body.reason.length > 500) {
            return new Response(
                JSON.stringify({ error: 'Reason exceeds 500 character limit' }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }
    }

    // 3. Update media visibility with transaction and row-level locking
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Lock the row to prevent concurrent modifications (Requirement 6.1)
        const lockResult = await client.query(
            'SELECT media_id FROM media WHERE media_id = $1 FOR UPDATE',
            [mediaId]
        );

        if (lockResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return new Response(
                JSON.stringify({ error: 'Media not found' }),
                { status: 404, headers: { 'Content-Type': 'application/json' } }
            );
        }

        // Update media visibility (Requirements 1.2, 1.3, 1.4)
        const updateResult = await client.query(
            `UPDATE media
             SET is_hidden = $1,
                 hidden_at = CASE WHEN $1 = true THEN now() ELSE NULL END,
                 hidden_by = CASE WHEN $1 = true THEN $2 ELSE NULL END
             WHERE media_id = $3
             RETURNING media_id, is_hidden, hidden_at, hidden_by`,
            [body.hidden, adminUserId, mediaId]
        );

        // 4. Insert moderation log entry (Requirements 4.1, 4.2, 5.2)
        await client.query(
            `INSERT INTO media_moderation_log (media_id, admin_id, action, reason)
             VALUES ($1, $2, $3, $4)`,
            [
                mediaId,
                adminUserId,
                body.hidden ? 'hide' : 'unhide',
                body.reason || null
            ]
        );

        await client.query('COMMIT');

        // 5. Return success response with updated state (Requirements 1.5, 6.2)
        const updatedMedia = updateResult.rows[0];
        const response: ToggleVisibilityResponse = {
            success: true,
            media_id: updatedMedia.media_id,
            is_hidden: updatedMedia.is_hidden,
            hidden_at: updatedMedia.hidden_at,
            hidden_by: updatedMedia.hidden_by
        };

        return new Response(
            JSON.stringify(response),
            { 
                status: 200, 
                headers: { 'Content-Type': 'application/json' } 
            }
        );
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error toggling media visibility:', error);
        return new Response(
            JSON.stringify({ error: 'Internal server error' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    } finally {
        client.release();
    }
}
