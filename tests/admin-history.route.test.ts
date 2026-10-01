// Unit tests for GET /api/admin/media/[media_id]/history — Task 3.5
//
// Tests the moderation history endpoint for retrieving audit trail of hide/unhide actions.
// Mocks ONLY the database boundary (@/lib/db), while using REAL JWT verification
// (@/lib/auth) to test authentication and authorization logic end-to-end.
//
// Covered requirements:
//  - 4.3: Display moderation history for each media item
//  - 4.4: Display administrator who performed each action and timestamp
//  - 5.3: Display moderation reason in history

import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { NextRequest } from 'next/server';

// --- Mock database before importing route -----------------------------------
const { queryMock } = vi.hoisted(() => {
    const queryMock = vi.fn();
    return { queryMock };
});

vi.mock('@/lib/db', () => ({
    default: { query: queryMock },
}));

// Import route after mocks are set up
import { GET } from '@/app/api/admin/media/[media_id]/history/route';

// --- Test fixtures ----------------------------------------------------------
const TEST_SECRET = 'admin-history-test-secret';
const ADMIN_USER_ID = 42;
const NON_ADMIN_USER_ID = 99;
const MEDIA_ID = 100;

function signToken(userId: number, isAdmin: boolean): string {
    return jwt.sign(
        { userId, email: isAdmin ? 'admin@test.com' : 'user@test.com', isAdmin },
        TEST_SECRET,
        { expiresIn: '1h' }
    );
}

function createRequest(mediaId: number, token?: string): NextRequest {
    const url = `http://localhost/api/admin/media/${mediaId}/history`;
    const headers: HeadersInit = {};
    
    if (token) {
        // Set as cookie since verifyRequest reads from auth_token cookie
        headers.Cookie = `auth_token=${token}`;
    }
    
    return new NextRequest(url, {
        method: 'GET',
        headers,
    });
}

// --- Test suite -------------------------------------------------------------
describe('GET /api/admin/media/[media_id]/history', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.JWT_SECRET = TEST_SECRET;
    });

    // --- Authentication & Authorization Tests ---
    
    it('returns 401 when no auth token is provided', async () => {
        const request = createRequest(MEDIA_ID);
        const params = Promise.resolve({ media_id: String(MEDIA_ID) });
        
        const response = await GET(request, { params });
        
        expect(response.status).toBe(401);
        const body = await response.text();
        expect(body).toBe('Unauthorized');
    });

    it('returns 403 when user is not an admin', async () => {
        const token = signToken(NON_ADMIN_USER_ID, false);
        const request = createRequest(MEDIA_ID, token);
        const params = Promise.resolve({ media_id: String(MEDIA_ID) });
        
        const response = await GET(request, { params });
        
        expect(response.status).toBe(403);
        const body = await response.json();
        expect(body.error).toContain('Admin access required');
    });

    // --- Request Validation Tests ---
    
    it('returns 400 when media_id is not a valid number', async () => {
        const token = signToken(ADMIN_USER_ID, true);
        const request = createRequest(0, token);
        const params = Promise.resolve({ media_id: 'not-a-number' });
        
        const response = await GET(request, { params });
        
        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.error).toContain('Invalid media_id');
    });

    // --- Media Not Found Test ---
    
    it('returns 404 when media item does not exist', async () => {
        const token = signToken(ADMIN_USER_ID, true);
        const request = createRequest(MEDIA_ID, token);
        const params = Promise.resolve({ media_id: String(MEDIA_ID) });
        
        // Mock: media check returns no rows
        queryMock.mockResolvedValueOnce({ rows: [] });
        
        const response = await GET(request, { params });
        
        expect(response.status).toBe(404);
        const body = await response.json();
        expect(body.error).toBe('Media not found');
        
        // Verify media check query was called
        expect(queryMock).toHaveBeenCalledWith(
            'SELECT media_id FROM media WHERE media_id = $1',
            [MEDIA_ID]
        );
    });

    // --- Successful History Retrieval ---
    
    it('returns empty history when media exists but has no moderation log', async () => {
        const token = signToken(ADMIN_USER_ID, true);
        const request = createRequest(MEDIA_ID, token);
        const params = Promise.resolve({ media_id: String(MEDIA_ID) });
        
        // Mock: media exists, but no moderation log entries
        queryMock
            .mockResolvedValueOnce({ rows: [{ media_id: MEDIA_ID }] }) // media check
            .mockResolvedValueOnce({ rows: [] }); // moderation log query
        
        const response = await GET(request, { params });
        
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toEqual({
            media_id: MEDIA_ID,
            history: []
        });
    });

    it('returns complete moderation history with all details (Requirement 4.3, 4.4, 5.3)', async () => {
        const token = signToken(ADMIN_USER_ID, true);
        const request = createRequest(MEDIA_ID, token);
        const params = Promise.resolve({ media_id: String(MEDIA_ID) });
        
        const now = new Date('2024-01-15T10:30:00Z');
        const earlier = new Date('2024-01-14T15:20:00Z');
        
        // Mock: media exists with two moderation log entries
        queryMock
            .mockResolvedValueOnce({ rows: [{ media_id: MEDIA_ID }] }) // media check
            .mockResolvedValueOnce({ 
                rows: [
                    {
                        log_id: 2,
                        admin_id: 42,
                        admin_username: 'admin1',
                        action: 'unhide',
                        reason: null,
                        created_at: now
                    },
                    {
                        log_id: 1,
                        admin_id: 42,
                        admin_username: 'admin1',
                        action: 'hide',
                        reason: 'Inappropriate content',
                        created_at: earlier
                    }
                ]
            }); // moderation log query
        
        const response = await GET(request, { params });
        
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toEqual({
            media_id: MEDIA_ID,
            history: [
                {
                    log_id: 2,
                    media_id: MEDIA_ID,
                    admin_id: 42,
                    admin_username: 'admin1',
                    action: 'unhide',
                    reason: null,
                    created_at: now.toISOString()
                },
                {
                    log_id: 1,
                    media_id: MEDIA_ID,
                    admin_id: 42,
                    admin_username: 'admin1',
                    action: 'hide',
                    reason: 'Inappropriate content',
                    created_at: earlier.toISOString()
                }
            ]
        });
        
        // Verify the query joined with users table for admin_username
        expect(queryMock).toHaveBeenCalledWith(
            expect.stringContaining('JOIN users u ON ml.admin_id = u.user_id'),
            [MEDIA_ID]
        );
        
        // Verify chronological ordering (newest first)
        expect(queryMock).toHaveBeenCalledWith(
            expect.stringContaining('ORDER BY ml.created_at DESC'),
            [MEDIA_ID]
        );
    });

    it('returns history with multiple admins and actions', async () => {
        const token = signToken(ADMIN_USER_ID, true);
        const request = createRequest(MEDIA_ID, token);
        const params = Promise.resolve({ media_id: String(MEDIA_ID) });
        
        const time1 = new Date('2024-01-15T10:00:00Z');
        const time2 = new Date('2024-01-15T11:00:00Z');
        const time3 = new Date('2024-01-15T12:00:00Z');
        
        // Mock: media exists with three moderation log entries from different admins
        queryMock
            .mockResolvedValueOnce({ rows: [{ media_id: MEDIA_ID }] }) // media check
            .mockResolvedValueOnce({ 
                rows: [
                    {
                        log_id: 3,
                        admin_id: 99,
                        admin_username: 'admin2',
                        action: 'hide',
                        reason: 'Spam',
                        created_at: time3
                    },
                    {
                        log_id: 2,
                        admin_id: 42,
                        admin_username: 'admin1',
                        action: 'unhide',
                        reason: null,
                        created_at: time2
                    },
                    {
                        log_id: 1,
                        admin_id: 42,
                        admin_username: 'admin1',
                        action: 'hide',
                        reason: 'Inappropriate',
                        created_at: time1
                    }
                ]
            }); // moderation log query
        
        const response = await GET(request, { params });
        
        expect(response.status).toBe(200);
        const body = await response.json();
        
        // Verify all three entries are returned in chronological order
        expect(body.history).toHaveLength(3);
        expect(body.history[0].log_id).toBe(3);
        expect(body.history[0].admin_username).toBe('admin2');
        expect(body.history[1].log_id).toBe(2);
        expect(body.history[1].admin_username).toBe('admin1');
        expect(body.history[2].log_id).toBe(1);
        expect(body.history[2].admin_username).toBe('admin1');
    });

    it('includes reason field even when null (Requirement 5.3)', async () => {
        const token = signToken(ADMIN_USER_ID, true);
        const request = createRequest(MEDIA_ID, token);
        const params = Promise.resolve({ media_id: String(MEDIA_ID) });
        
        const now = new Date();
        
        // Mock: media with unhide action (no reason)
        queryMock
            .mockResolvedValueOnce({ rows: [{ media_id: MEDIA_ID }] })
            .mockResolvedValueOnce({ 
                rows: [{
                    log_id: 1,
                    admin_id: 42,
                    admin_username: 'admin1',
                    action: 'unhide',
                    reason: null,
                    created_at: now
                }]
            });
        
        const response = await GET(request, { params });
        const body = await response.json();
        
        // Verify reason field is present and null, and media_id is included
        expect(body.history[0]).toHaveProperty('reason');
        expect(body.history[0].reason).toBeNull();
        expect(body.history[0].media_id).toBe(MEDIA_ID);
    });

    // --- Error Handling ---
    
    it('returns 500 on database error during media check', async () => {
        const token = signToken(ADMIN_USER_ID, true);
        const request = createRequest(MEDIA_ID, token);
        const params = Promise.resolve({ media_id: String(MEDIA_ID) });
        
        // Mock: database error during media check
        queryMock.mockRejectedValueOnce(new Error('Database connection lost'));
        
        const response = await GET(request, { params });
        
        expect(response.status).toBe(500);
        const body = await response.json();
        expect(body.error).toBe('Internal server error');
    });

    it('returns 500 on database error during history query', async () => {
        const token = signToken(ADMIN_USER_ID, true);
        const request = createRequest(MEDIA_ID, token);
        const params = Promise.resolve({ media_id: String(MEDIA_ID) });
        
        // Mock: media check succeeds, but history query fails
        queryMock
            .mockResolvedValueOnce({ rows: [{ media_id: MEDIA_ID }] })
            .mockRejectedValueOnce(new Error('Database error'));
        
        const response = await GET(request, { params });
        
        expect(response.status).toBe(500);
        const body = await response.json();
        expect(body.error).toBe('Internal server error');
    });
});
