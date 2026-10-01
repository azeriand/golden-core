// Unit tests for GET /api/admin/media — Task 3.3
//
// Tests the admin media listing endpoint with filtering and pagination.
// Mocks ONLY the database boundary (@/lib/db), while using REAL JWT verification
// (@/lib/auth) to test authentication and authorization logic end-to-end.
//
// Covered requirements:
//  - 2.1: Display current Hidden_State for each Media_Item
//  - 2.3: Filter Media_Items by Hidden_State
//  - 2.4: Return Hidden_State attribute in admin API responses

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
import { GET } from '@/app/api/admin/media/route';

// --- Test fixtures ----------------------------------------------------------
const TEST_SECRET = 'admin-media-list-test-secret';
const ADMIN_USER_ID = 42;
const NON_ADMIN_USER_ID = 99;
const EVENT_ID = 1;

function signToken(userId: number, isAdmin: boolean): string {
    return jwt.sign(
        { userId, email: isAdmin ? 'admin@test.com' : 'user@test.com', isAdmin },
        TEST_SECRET,
        { expiresIn: '1h' }
    );
}

function createRequest(queryParams: Record<string, string>, token?: string): NextRequest {
    const params = new URLSearchParams(queryParams);
    const url = `http://localhost/api/admin/media?${params.toString()}`;
    const headers: HeadersInit = {};
    
    if (token) {
        headers.Cookie = `auth_token=${token}`;
    }
    
    return new NextRequest(url, {
        method: 'GET',
        headers,
    });
}

function createMediaRow(overrides: Record<string, unknown> = {}) {
    return {
        media_id: 1,
        user_id: 10,
        content: 'https://example.com/image.jpg',
        type: 'image/jpeg',
        date: '2024-01-01T00:00:00Z',
        section_id: null,
        blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
        poster_url: null,
        original_url: null,
        width: 1920,
        height: 1080,
        is_hidden: false,
        hidden_at: null,
        hidden_by: null,
        username: 'testuser',
        likes: 5,
        liked: false,
        hidden_by_username: null,
        ...overrides,
    };
}

// --- Test suite -------------------------------------------------------------
describe('GET /api/admin/media', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.JWT_SECRET = TEST_SECRET;
    });

    // --- Authentication & Authorization Tests ---
    
    it('returns 401 when no auth token is provided', async () => {
        const request = createRequest({ event_id: String(EVENT_ID) });
        
        const response = await GET(request);
        
        expect(response.status).toBe(401);
        const body = await response.text();
        expect(body).toBe('Unauthorized');
    });

    it('returns 403 when user is not an admin', async () => {
        const token = signToken(NON_ADMIN_USER_ID, false);
        const request = createRequest({ event_id: String(EVENT_ID) }, token);
        
        const response = await GET(request);
        
        expect(response.status).toBe(403);
        const body = await response.json();
        expect(body.error).toContain('Admin access required');
    });

    // --- Parameter Validation Tests ---
    
    it('returns 400 when event_id is missing', async () => {
        const token = signToken(ADMIN_USER_ID, true);
        const request = createRequest({}, token);
        
        const response = await GET(request);
        
        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.error).toContain('Missing required parameter: event_id');
    });

    it('returns 400 when event_id is not a valid number', async () => {
        const token = signToken(ADMIN_USER_ID, true);
        const request = createRequest({ event_id: 'not-a-number' }, token);
        
        const response = await GET(request);
        
        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.error).toContain('Invalid event_id: must be a number');
    });

    it('returns 400 when hidden parameter is invalid', async () => {
        const token = signToken(ADMIN_USER_ID, true);
        const request = createRequest({ event_id: String(EVENT_ID), hidden: 'maybe' }, token);
        
        const response = await GET(request);
        
        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.error).toContain('Invalid hidden parameter');
    });

    it('returns 400 when section_id is not a valid number', async () => {
        const token = signToken(ADMIN_USER_ID, true);
        const request = createRequest({ 
            event_id: String(EVENT_ID), 
            section_id: 'not-a-number' 
        }, token);
        
        const response = await GET(request);
        
        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.error).toContain('Invalid section_id: must be a number');
    });

    it('returns 400 when limit is not a positive number', async () => {
        const token = signToken(ADMIN_USER_ID, true);
        const request = createRequest({ event_id: String(EVENT_ID), limit: '-5' }, token);
        
        const response = await GET(request);
        
        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.error).toContain('Invalid limit');
    });

    it('returns 400 when offset is negative', async () => {
        const token = signToken(ADMIN_USER_ID, true);
        const request = createRequest({ event_id: String(EVENT_ID), offset: '-10' }, token);
        
        const response = await GET(request);
        
        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.error).toContain('Invalid offset');
    });

    it('caps limit at 200 when larger value is provided', async () => {
        const token = signToken(ADMIN_USER_ID, true);
        const request = createRequest({ event_id: String(EVENT_ID), limit: '500' }, token);
        
        queryMock
            .mockResolvedValueOnce({ rows: [] }) // media query
            .mockResolvedValueOnce({ rows: [{ total: 0 }] }); // count query
        
        await GET(request);
        
        // Verify that the query was called with limit of 200, not 500
        expect(queryMock).toHaveBeenCalledWith(
            expect.stringContaining('LIMIT'),
            expect.arrayContaining([200])
        );
    });

    // --- Successful Query Tests ---
    
    it('returns all media for an event with default parameters', async () => {
        const token = signToken(ADMIN_USER_ID, true);
        const request = createRequest({ event_id: String(EVENT_ID) }, token);
        
        const mediaRows = [
            createMediaRow({ media_id: 1 }),
            createMediaRow({ media_id: 2, is_hidden: true, hidden_at: '2024-01-02T00:00:00Z', hidden_by: ADMIN_USER_ID, hidden_by_username: 'admin' }),
        ];
        
        queryMock
            .mockResolvedValueOnce({ rows: mediaRows }) // media query
            .mockResolvedValueOnce({ rows: [{ total: '2' }] }); // count query
        
        const response = await GET(request);
        
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toEqual({
            media: mediaRows,
            total: 2,
            has_more: false
        });
        
        // Verify query includes event_id filter
        expect(queryMock).toHaveBeenCalledWith(
            expect.stringContaining('m.event_id = $1'),
            expect.anything()
        );
    });

    it('filters by hidden=true to show only hidden media (Requirement 2.3)', async () => {
        const token = signToken(ADMIN_USER_ID, true);
        const request = createRequest({ event_id: String(EVENT_ID), hidden: 'true' }, token);
        
        const hiddenMedia = [
            createMediaRow({ 
                media_id: 2, 
                is_hidden: true, 
                hidden_at: '2024-01-02T00:00:00Z', 
                hidden_by: ADMIN_USER_ID, 
                hidden_by_username: 'admin' 
            }),
        ];
        
        queryMock
            .mockResolvedValueOnce({ rows: hiddenMedia }) // media query
            .mockResolvedValueOnce({ rows: [{ total: '1' }] }); // count query
        
        const response = await GET(request);
        
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.media).toHaveLength(1);
        expect(body.media[0].is_hidden).toBe(true);
        expect(body.total).toBe(1);
        
        // Verify query includes is_hidden filter
        expect(queryMock).toHaveBeenCalledWith(
            expect.stringContaining('m.is_hidden = true'),
            expect.anything()
        );
    });

    it('filters by hidden=false to show only visible media (Requirement 2.3)', async () => {
        const token = signToken(ADMIN_USER_ID, true);
        const request = createRequest({ event_id: String(EVENT_ID), hidden: 'false' }, token);
        
        const visibleMedia = [
            createMediaRow({ media_id: 1 }),
        ];
        
        queryMock
            .mockResolvedValueOnce({ rows: visibleMedia }) // media query
            .mockResolvedValueOnce({ rows: [{ total: '1' }] }); // count query
        
        const response = await GET(request);
        
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.media).toHaveLength(1);
        expect(body.media[0].is_hidden).toBe(false);
        
        // Verify query includes is_hidden filter
        expect(queryMock).toHaveBeenCalledWith(
            expect.stringContaining('m.is_hidden = false'),
            expect.anything()
        );
    });

    it('includes visibility metadata in response (Requirement 2.4)', async () => {
        const token = signToken(ADMIN_USER_ID, true);
        const request = createRequest({ event_id: String(EVENT_ID) }, token);
        
        const hiddenMedia = createMediaRow({ 
            media_id: 1, 
            is_hidden: true, 
            hidden_at: '2024-01-02T00:00:00Z', 
            hidden_by: ADMIN_USER_ID, 
            hidden_by_username: 'admin_user' 
        });
        
        queryMock
            .mockResolvedValueOnce({ rows: [hiddenMedia] }) // media query
            .mockResolvedValueOnce({ rows: [{ total: '1' }] }); // count query
        
        const response = await GET(request);
        
        expect(response.status).toBe(200);
        const body = await response.json();
        
        // Verify all admin metadata fields are present (Requirement 2.4)
        expect(body.media[0]).toHaveProperty('is_hidden', true);
        expect(body.media[0]).toHaveProperty('hidden_at', '2024-01-02T00:00:00Z');
        expect(body.media[0]).toHaveProperty('hidden_by', ADMIN_USER_ID);
        expect(body.media[0]).toHaveProperty('hidden_by_username', 'admin_user');
    });

    it('filters by section_id when provided', async () => {
        const token = signToken(ADMIN_USER_ID, true);
        const sectionId = 5;
        const request = createRequest({ 
            event_id: String(EVENT_ID), 
            section_id: String(sectionId) 
        }, token);
        
        const sectionMedia = [
            createMediaRow({ media_id: 1, section_id: sectionId }),
        ];
        
        queryMock
            .mockResolvedValueOnce({ rows: sectionMedia }) // media query
            .mockResolvedValueOnce({ rows: [{ total: '1' }] }); // count query
        
        const response = await GET(request);
        
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.media[0].section_id).toBe(sectionId);
        
        // Verify query includes section_id filter
        expect(queryMock).toHaveBeenCalledWith(
            expect.stringContaining('m.section_id'),
            expect.arrayContaining([EVENT_ID, sectionId])
        );
    });

    it('handles pagination with limit and offset', async () => {
        const token = signToken(ADMIN_USER_ID, true);
        const request = createRequest({ 
            event_id: String(EVENT_ID), 
            limit: '10', 
            offset: '20' 
        }, token);
        
        const mediaRows = Array.from({ length: 10 }, (_, i) => 
            createMediaRow({ media_id: i + 21 })
        );
        
        queryMock
            .mockResolvedValueOnce({ rows: mediaRows }) // media query
            .mockResolvedValueOnce({ rows: [{ total: '100' }] }); // count query
        
        const response = await GET(request);
        
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.media).toHaveLength(10);
        expect(body.total).toBe(100);
        expect(body.has_more).toBe(true); // 20 + 10 < 100
        
        // Verify query includes limit and offset
        expect(queryMock).toHaveBeenCalledWith(
            expect.stringContaining('LIMIT'),
            expect.arrayContaining([10, 20])
        );
    });

    it('sets has_more to false when at the end of results', async () => {
        const token = signToken(ADMIN_USER_ID, true);
        const request = createRequest({ 
            event_id: String(EVENT_ID), 
            limit: '10', 
            offset: '45' 
        }, token);
        
        const mediaRows = Array.from({ length: 5 }, (_, i) => 
            createMediaRow({ media_id: i + 46 })
        );
        
        queryMock
            .mockResolvedValueOnce({ rows: mediaRows }) // media query
            .mockResolvedValueOnce({ rows: [{ total: '50' }] }); // count query
        
        const response = await GET(request);
        
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.has_more).toBe(false); // 45 + 5 = 50, no more results
    });

    it('returns empty array when no media matches filters', async () => {
        const token = signToken(ADMIN_USER_ID, true);
        const request = createRequest({ event_id: String(EVENT_ID) }, token);
        
        queryMock
            .mockResolvedValueOnce({ rows: [] }) // media query
            .mockResolvedValueOnce({ rows: [{ total: '0' }] }); // count query
        
        const response = await GET(request);
        
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toEqual({
            media: [],
            total: 0,
            has_more: false
        });
    });

    // --- Error Handling ---
    
    it('returns 500 on database error', async () => {
        const token = signToken(ADMIN_USER_ID, true);
        const request = createRequest({ event_id: String(EVENT_ID) }, token);
        
        queryMock.mockRejectedValueOnce(new Error('Database connection lost'));
        
        const response = await GET(request);
        
        expect(response.status).toBe(500);
        const body = await response.json();
        expect(body.error).toBe('Internal server error');
    });

    // --- Combined Filters Test ---
    
    it('handles multiple filters together', async () => {
        const token = signToken(ADMIN_USER_ID, true);
        const sectionId = 3;
        const request = createRequest({ 
            event_id: String(EVENT_ID), 
            hidden: 'true',
            section_id: String(sectionId),
            limit: '25',
            offset: '0'
        }, token);
        
        const filteredMedia = [
            createMediaRow({ 
                media_id: 1, 
                section_id: sectionId,
                is_hidden: true, 
                hidden_at: '2024-01-02T00:00:00Z', 
                hidden_by: ADMIN_USER_ID 
            }),
        ];
        
        queryMock
            .mockResolvedValueOnce({ rows: filteredMedia }) // media query
            .mockResolvedValueOnce({ rows: [{ total: '1' }] }); // count query
        
        const response = await GET(request);
        
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.media).toHaveLength(1);
        
        // Verify all filters are applied
        const queryCall = queryMock.mock.calls[0];
        expect(queryCall[0]).toContain('m.event_id = $1');
        expect(queryCall[0]).toContain('m.is_hidden = true');
        expect(queryCall[0]).toContain('m.section_id');
        expect(queryCall[1]).toContain(EVENT_ID);
        expect(queryCall[1]).toContain(sectionId);
    });
});
