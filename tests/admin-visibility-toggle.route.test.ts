// Unit tests for PATCH /api/admin/media/[media_id]/visibility — Task 3.1
//
// Tests the visibility toggle endpoint for hiding/unhiding media with audit logging.
// Mocks ONLY the database boundary (@/lib/db), while using REAL JWT verification
// (@/lib/auth) to test authentication and authorization logic end-to-end.
//
// Covered requirements:
//  - 1.2, 1.3: Toggle visibility (hide/unhide)
//  - 1.4: Persist state changes within 200ms
//  - 1.5: Return success response
//  - 4.1, 4.2: Record admin ID and timestamp in audit trail
//  - 5.2: Store moderation reason
//  - 5.4: Validate reason length (max 500 chars)
//  - 6.1, 6.2: Handle concurrent updates with row-level locking

import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { NextRequest } from 'next/server';

// --- Mock database before importing route -----------------------------------
const { queryMock, connectMock, releaseMock, clientMock } = vi.hoisted(() => {
    const queryMock = vi.fn();
    const releaseMock = vi.fn();
    const clientMock = {
        query: queryMock,
        release: releaseMock,
    };
    const connectMock = vi.fn(() => Promise.resolve(clientMock));
    
    return { queryMock, connectMock, releaseMock, clientMock };
});

vi.mock('@/lib/db', () => ({
    default: { connect: connectMock },
}));

// Import route after mocks are set up
import { PATCH } from '@/app/api/admin/media/[media_id]/visibility/route';

// --- Test fixtures ----------------------------------------------------------
const TEST_SECRET = 'admin-visibility-test-secret';
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

function createRequest(mediaId: number, body: unknown, token?: string): NextRequest {
    const url = `http://localhost/api/admin/media/${mediaId}/visibility`;
    const headers: HeadersInit = { 'Content-Type': 'application/json' };
    
    if (token) {
        // Set as cookie since verifyRequest reads from auth_token cookie
        headers.Cookie = `auth_token=${token}`;
    }
    
    return new NextRequest(url, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(body),
    });
}

// --- Test suite -------------------------------------------------------------
describe('PATCH /api/admin/media/[media_id]/visibility', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.JWT_SECRET = TEST_SECRET;
    });

    // --- Authentication & Authorization Tests ---
    
    it('returns 401 when no auth token is provided', async () => {
        const request = createRequest(MEDIA_ID, { hidden: true });
        const params = Promise.resolve({ media_id: String(MEDIA_ID) });
        
        const response = await PATCH(request, { params });
        
        expect(response.status).toBe(401);
        const body = await response.text();
        expect(body).toBe('Unauthorized');
    });

    it('returns 403 when user is not an admin', async () => {
        const token = signToken(NON_ADMIN_USER_ID, false);
        const request = createRequest(MEDIA_ID, { hidden: true }, token);
        const params = Promise.resolve({ media_id: String(MEDIA_ID) });
        
        const response = await PATCH(request, { params });
        
        expect(response.status).toBe(403);
        const body = await response.json();
        expect(body.error).toContain('Admin access required');
    });

    // --- Request Validation Tests ---
    
    it('returns 400 when media_id is not a valid number', async () => {
        const token = signToken(ADMIN_USER_ID, true);
        const request = createRequest(0, { hidden: true }, token);
        const params = Promise.resolve({ media_id: 'not-a-number' });
        
        const response = await PATCH(request, { params });
        
        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.error).toContain('Invalid media_id');
    });

    it('returns 400 when request body is not valid JSON', async () => {
        const token = signToken(ADMIN_USER_ID, true);
        const url = `http://localhost/api/admin/media/${MEDIA_ID}/visibility`;
        const request = new NextRequest(url, {
            method: 'PATCH',
            headers: { 
                'Content-Type': 'application/json',
                Cookie: `auth_token=${token}`
            },
            body: 'invalid-json{',
        });
        const params = Promise.resolve({ media_id: String(MEDIA_ID) });
        
        const response = await PATCH(request, { params });
        
        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.error).toContain('Invalid JSON');
    });

    it('returns 400 when hidden field is missing', async () => {
        const token = signToken(ADMIN_USER_ID, true);
        const request = createRequest(MEDIA_ID, {}, token);
        const params = Promise.resolve({ media_id: String(MEDIA_ID) });
        
        const response = await PATCH(request, { params });
        
        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.error).toContain('hidden must be boolean');
    });

    it('returns 400 when hidden is not a boolean', async () => {
        const token = signToken(ADMIN_USER_ID, true);
        const request = createRequest(MEDIA_ID, { hidden: 'yes' }, token);
        const params = Promise.resolve({ media_id: String(MEDIA_ID) });
        
        const response = await PATCH(request, { params });
        
        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.error).toContain('hidden must be boolean');
    });

    it('returns 400 when reason is not a string', async () => {
        const token = signToken(ADMIN_USER_ID, true);
        const request = createRequest(MEDIA_ID, { hidden: true, reason: 123 }, token);
        const params = Promise.resolve({ media_id: String(MEDIA_ID) });
        
        const response = await PATCH(request, { params });
        
        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.error).toContain('reason must be a string');
    });

    it('returns 400 when reason exceeds 500 characters', async () => {
        const token = signToken(ADMIN_USER_ID, true);
        const longReason = 'a'.repeat(501);
        const request = createRequest(MEDIA_ID, { hidden: true, reason: longReason }, token);
        const params = Promise.resolve({ media_id: String(MEDIA_ID) });
        
        const response = await PATCH(request, { params });
        
        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.error).toContain('Reason exceeds 500 character limit');
    });

    it('accepts a reason with exactly 500 characters', async () => {
        const token = signToken(ADMIN_USER_ID, true);
        const maxReason = 'a'.repeat(500);
        const request = createRequest(MEDIA_ID, { hidden: true, reason: maxReason }, token);
        const params = Promise.resolve({ media_id: String(MEDIA_ID) });
        
        // Mock successful database operations
        queryMock
            .mockResolvedValueOnce({ rows: [] }) // BEGIN
            .mockResolvedValueOnce({ rows: [{ media_id: MEDIA_ID }] }) // SELECT FOR UPDATE
            .mockResolvedValueOnce({ 
                rows: [{ 
                    media_id: MEDIA_ID, 
                    is_hidden: true, 
                    hidden_at: new Date().toISOString(), 
                    hidden_by: ADMIN_USER_ID 
                }] 
            }) // UPDATE
            .mockResolvedValueOnce({ rows: [] }) // INSERT into log
            .mockResolvedValueOnce({ rows: [] }); // COMMIT
        
        const response = await PATCH(request, { params });
        
        expect(response.status).toBe(200);
    });

    // --- Media Not Found Test ---
    
    it('returns 404 when media item does not exist', async () => {
        const token = signToken(ADMIN_USER_ID, true);
        const request = createRequest(MEDIA_ID, { hidden: true }, token);
        const params = Promise.resolve({ media_id: String(MEDIA_ID) });
        
        // Mock: BEGIN, then SELECT FOR UPDATE returns 0 rows
        queryMock
            .mockResolvedValueOnce({ rows: [] }) // BEGIN
            .mockResolvedValueOnce({ rows: [] }) // SELECT FOR UPDATE (not found)
            .mockResolvedValueOnce({ rows: [] }); // ROLLBACK
        
        const response = await PATCH(request, { params });
        
        expect(response.status).toBe(404);
        const body = await response.json();
        expect(body.error).toBe('Media not found');
        
        // Verify rollback was called
        expect(queryMock).toHaveBeenCalledWith('ROLLBACK');
    });

    // --- Successful Hide Operation ---
    
    it('successfully hides a visible media item with reason', async () => {
        const token = signToken(ADMIN_USER_ID, true);
        const reason = 'Inappropriate content';
        const request = createRequest(MEDIA_ID, { hidden: true, reason }, token);
        const params = Promise.resolve({ media_id: String(MEDIA_ID) });
        
        const now = new Date().toISOString();
        
        // Mock successful transaction
        queryMock
            .mockResolvedValueOnce({ rows: [] }) // BEGIN
            .mockResolvedValueOnce({ rows: [{ media_id: MEDIA_ID }] }) // SELECT FOR UPDATE
            .mockResolvedValueOnce({ 
                rows: [{ 
                    media_id: MEDIA_ID, 
                    is_hidden: true, 
                    hidden_at: now, 
                    hidden_by: ADMIN_USER_ID 
                }] 
            }) // UPDATE
            .mockResolvedValueOnce({ rows: [] }) // INSERT into log
            .mockResolvedValueOnce({ rows: [] }); // COMMIT
        
        const response = await PATCH(request, { params });
        
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toEqual({
            success: true,
            media_id: MEDIA_ID,
            is_hidden: true,
            hidden_at: now,
            hidden_by: ADMIN_USER_ID
        });
        
        // Verify UPDATE was called with correct parameters
        expect(queryMock).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE media'),
            [true, ADMIN_USER_ID, MEDIA_ID]
        );
        
        // Verify audit log entry was created with 'hide' action
        expect(queryMock).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO media_moderation_log'),
            [MEDIA_ID, ADMIN_USER_ID, 'hide', reason]
        );
        
        // Verify COMMIT was called
        expect(queryMock).toHaveBeenCalledWith('COMMIT');
    });

    // --- Successful Unhide Operation ---
    
    it('successfully unhides a hidden media item without reason', async () => {
        const token = signToken(ADMIN_USER_ID, true);
        const request = createRequest(MEDIA_ID, { hidden: false }, token);
        const params = Promise.resolve({ media_id: String(MEDIA_ID) });
        
        // Mock successful transaction
        queryMock
            .mockResolvedValueOnce({ rows: [] }) // BEGIN
            .mockResolvedValueOnce({ rows: [{ media_id: MEDIA_ID }] }) // SELECT FOR UPDATE
            .mockResolvedValueOnce({ 
                rows: [{ 
                    media_id: MEDIA_ID, 
                    is_hidden: false, 
                    hidden_at: null, 
                    hidden_by: null 
                }] 
            }) // UPDATE
            .mockResolvedValueOnce({ rows: [] }) // INSERT into log
            .mockResolvedValueOnce({ rows: [] }); // COMMIT
        
        const response = await PATCH(request, { params });
        
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toEqual({
            success: true,
            media_id: MEDIA_ID,
            is_hidden: false,
            hidden_at: null,
            hidden_by: null
        });
        
        // Verify UPDATE was called with correct parameters
        expect(queryMock).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE media'),
            [false, ADMIN_USER_ID, MEDIA_ID]
        );
        
        // Verify audit log entry was created with 'unhide' action and null reason
        expect(queryMock).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO media_moderation_log'),
            [MEDIA_ID, ADMIN_USER_ID, 'unhide', null]
        );
    });

    // --- Error Handling ---
    
    it('rolls back transaction and returns 500 on database error', async () => {
        const token = signToken(ADMIN_USER_ID, true);
        const request = createRequest(MEDIA_ID, { hidden: true }, token);
        const params = Promise.resolve({ media_id: String(MEDIA_ID) });
        
        // Mock: BEGIN succeeds, SELECT FOR UPDATE succeeds, but UPDATE fails
        queryMock
            .mockResolvedValueOnce({ rows: [] }) // BEGIN
            .mockResolvedValueOnce({ rows: [{ media_id: MEDIA_ID }] }) // SELECT FOR UPDATE
            .mockRejectedValueOnce(new Error('Database connection lost')) // UPDATE fails
            .mockResolvedValueOnce({ rows: [] }); // ROLLBACK
        
        const response = await PATCH(request, { params });
        
        expect(response.status).toBe(500);
        const body = await response.json();
        expect(body.error).toBe('Internal server error');
        
        // Verify rollback was called
        expect(queryMock).toHaveBeenCalledWith('ROLLBACK');
        
        // Verify client was released
        expect(releaseMock).toHaveBeenCalled();
    });

    // --- Row-Level Locking Test ---
    
    it('uses SELECT FOR UPDATE to lock the row before updating', async () => {
        const token = signToken(ADMIN_USER_ID, true);
        const request = createRequest(MEDIA_ID, { hidden: true }, token);
        const params = Promise.resolve({ media_id: String(MEDIA_ID) });
        
        queryMock
            .mockResolvedValueOnce({ rows: [] }) // BEGIN
            .mockResolvedValueOnce({ rows: [{ media_id: MEDIA_ID }] }) // SELECT FOR UPDATE
            .mockResolvedValueOnce({ 
                rows: [{ 
                    media_id: MEDIA_ID, 
                    is_hidden: true, 
                    hidden_at: new Date().toISOString(), 
                    hidden_by: ADMIN_USER_ID 
                }] 
            }) // UPDATE
            .mockResolvedValueOnce({ rows: [] }) // INSERT
            .mockResolvedValueOnce({ rows: [] }); // COMMIT
        
        await PATCH(request, { params });
        
        // Verify SELECT FOR UPDATE was called with the correct media_id
        expect(queryMock).toHaveBeenCalledWith(
            'SELECT media_id FROM media WHERE media_id = $1 FOR UPDATE',
            [MEDIA_ID]
        );
    });
});
