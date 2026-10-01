// GET /api/admin/media
//
// Retrieve media items with admin metadata and filtering capabilities.
//
// Task 3.3: Create GET endpoint for admin media with filtering
// Requirements: 2.1, 2.3, 2.4
//
// This endpoint allows administrators to:
//  - View all media items with visibility metadata
//  - Filter by event, visibility state (hidden/visible/all), and section
//  - Paginate through results
//  - See who hidden each hidden media item and when
//
// Query Parameters:
//  - event_id (required): Filter by event ID
//  - hidden (optional): 'true' | 'false' | 'all' (default: 'all')
//  - section_id (optional): Filter by section ID
//  - limit (optional): Page size (default: 50, max: 200)
//  - offset (optional): Pagination offset (default: 0)

import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { verifyRequest, requireAdmin } from '@/lib/auth';
import { AdminMedia } from '@/app/dto/admin-media';

interface AdminMediaResponse {
    media: AdminMedia[];
    total: number;
    has_more: boolean;
}

export async function GET(request: NextRequest): Promise<Response> {
    // 1. Verify admin authentication (Requirement 2.1)
    const auth = verifyRequest(request);
    const errorResponse = requireAdmin(auth);
    if (errorResponse) {
        return errorResponse;
    }

    // At this point, auth.ok is true and auth.user.isAdmin is true
    if (!auth.ok) {
        throw new Error('Unreachable: requireAdmin should have returned an error');
    }

    // 2. Parse and validate query parameters
    const { searchParams } = new URL(request.url);
    
    // Required: event_id
    const eventIdParam = searchParams.get('event_id');
    if (!eventIdParam) {
        return new Response(
            JSON.stringify({ error: 'Missing required parameter: event_id' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
    }
    
    const eventId = parseInt(eventIdParam, 10);
    if (isNaN(eventId)) {
        return new Response(
            JSON.stringify({ error: 'Invalid event_id: must be a number' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
    }

    // Optional: hidden filter (Requirement 2.3)
    const hiddenParam = searchParams.get('hidden') || 'all';
    if (!['true', 'false', 'all'].includes(hiddenParam)) {
        return new Response(
            JSON.stringify({ error: 'Invalid hidden parameter: must be "true", "false", or "all"' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
    }

    // Optional: section_id
    const sectionIdParam = searchParams.get('section_id');
    let sectionId: number | null = null;
    if (sectionIdParam) {
        sectionId = parseInt(sectionIdParam, 10);
        if (isNaN(sectionId)) {
            return new Response(
                JSON.stringify({ error: 'Invalid section_id: must be a number' }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }
    }

    // Optional: limit (default 50, max 200)
    const limitParam = searchParams.get('limit');
    let limit = 50;
    if (limitParam) {
        limit = parseInt(limitParam, 10);
        if (isNaN(limit) || limit < 1) {
            return new Response(
                JSON.stringify({ error: 'Invalid limit: must be a positive number' }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }
        if (limit > 200) {
            limit = 200;
        }
    }

    // Optional: offset (default 0)
    const offsetParam = searchParams.get('offset');
    let offset = 0;
    if (offsetParam) {
        offset = parseInt(offsetParam, 10);
        if (isNaN(offset) || offset < 0) {
            return new Response(
                JSON.stringify({ error: 'Invalid offset: must be a non-negative number' }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }
    }

    // 3. Build query with filters
    const queryParams: (number | string | boolean)[] = [eventId];
    let paramIndex = 2;

    // Build WHERE clauses
    const whereClauses = ['m.event_id = $1'];

    // Add hidden filter (Requirement 2.3)
    if (hiddenParam === 'true') {
        whereClauses.push('m.is_hidden = true');
    } else if (hiddenParam === 'false') {
        whereClauses.push('m.is_hidden = false');
    }
    // If 'all', no filter is added

    // Add section filter
    if (sectionId !== null) {
        whereClauses.push(`m.section_id = $${paramIndex}`);
        queryParams.push(sectionId);
        paramIndex++;
    }

    const whereClause = whereClauses.join(' AND ');

    // Save the filter params for the count query (before adding userId, limit, offset)
    const countParams = [...queryParams];

    // 4. Query media with admin metadata (Requirement 2.4)
    // Include username, hidden_by username, and likes count
    try {
        const mediaQuery = `
            SELECT 
                m.media_id,
                m.user_id,
                m.content,
                m.type,
                m.date,
                m.section_id,
                m.blurhash,
                m.poster_url,
                m.original_url,
                m.width,
                m.height,
                m.is_hidden,
                m.hidden_at,
                m.hidden_by,
                u.username,
                COALESCE(l.like_count, 0) AS likes,
                CASE 
                    WHEN l_user.user_id IS NOT NULL THEN true 
                    ELSE false 
                END AS liked,
                hidden_by_user.username AS hidden_by_username
            FROM media m
            JOIN users u ON m.user_id = u.user_id
            LEFT JOIN (
                SELECT media_id, COUNT(*) AS like_count
                FROM likes
                GROUP BY media_id
            ) l ON m.media_id = l.media_id
            LEFT JOIN likes l_user ON m.media_id = l_user.media_id AND l_user.user_id = $${paramIndex}
            LEFT JOIN users hidden_by_user ON m.hidden_by = hidden_by_user.user_id
            WHERE ${whereClause}
            ORDER BY m.date DESC
            LIMIT $${paramIndex + 1} OFFSET $${paramIndex + 2}
        `;

        queryParams.push(auth.user.userId, limit, offset);

        const mediaResult = await pool.query(mediaQuery, queryParams);

        // 5. Get total count for pagination
        const countQuery = `
            SELECT COUNT(*) AS total
            FROM media m
            WHERE ${whereClause}
        `;

        const countResult = await pool.query(countQuery, countParams);

        const total = parseInt(countResult.rows[0].total, 10);
        const has_more = offset + mediaResult.rows.length < total;

        // 6. Return paginated results
        const response: AdminMediaResponse = {
            media: mediaResult.rows,
            total,
            has_more
        };

        return new Response(
            JSON.stringify(response),
            {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    } catch (error) {
        console.error('Error fetching admin media:', error);
        return new Response(
            JSON.stringify({ error: 'Internal server error' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
}
