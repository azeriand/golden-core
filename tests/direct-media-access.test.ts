// Unit tests for direct media access endpoints with hidden media filtering.
// Validates Requirement 3.4: "If a non-administrator user requests a hidden
// Media_Item directly, THEN THE System SHALL return a not-found response"

import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { NextRequest } from 'next/server';

// --- Mock database before importing routes -----------------------------------
const queryMock = vi.fn();

vi.mock('@/lib/db', () => ({
    default: { query: queryMock },
}));

// Mock the demo guard
vi.mock('@/lib/demo-guard', () => ({
    isDemoEvent: vi.fn(() => false),
    demoGuardResponse: vi.fn(),
}));

// Mock the sections module
vi.mock('@/lib/sections', () => ({
    isUnclassifiedSectionId: vi.fn(() => false),
}));

// Mock global fetch for blob download
global.fetch = vi.fn();

// Import routes after mocks are set up
import { GET as downloadMediaGET } from '@/app/api/event/[event-slug]/media/[media-id]/download/route';
import { POST as likeMediaPOST } from '@/app/api/event/[event-slug]/media/[media-id]/likes/route';
import { PATCH as updateMediaPATCH } from '@/app/api/event/[event-slug]/media/[media-id]/route';

// --- Test fixtures ----------------------------------------------------------
const TEST_SECRET = 'direct-media-access-test-secret';
const ADMIN_USER_ID = 1;
const NON_ADMIN_USER_ID = 2;

function signToken(userId: number, isAdmin: boolean): string {
    return jwt.sign(
        { userId, email: isAdmin ? 'admin@test.com' : 'user@test.com', isAdmin },
        TEST_SECRET,
        { expiresIn: '1h' }
    );
}

function createRequest(url: string, method: string, token?: string, body?: unknown): NextRequest {
    const headers: HeadersInit = { 'Content-Type': 'application/json' };
    
    if (token) {
        headers.Cookie = `auth_token=${token}`;
    }
    
    const options: RequestInit = {
        method,
        headers,
    };
    
    if (body) {
        options.body = JSON.stringify(body);
    }
    
    return new NextRequest(url, options);
}

describe('Direct media access with hidden media filtering', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.JWT_SECRET = TEST_SECRET;
    });

    describe('Download endpoint (GET /api/event/[event-slug]/media/[media-id]/download)', () => {
        it('returns 404 when non-admin tries to download hidden media', async () => {
            const token = signToken(NON_ADMIN_USER_ID, false);
            
            // Mock database query to return no results (hidden media filtered out)
            queryMock.mockResolvedValue({
                rows: [],
                command: 'SELECT',
                rowCount: 0,
                oid: 0,
                fields: [],
            });

            const request = createRequest(
                'http://localhost/api/event/test-event/media/1/download',
                'GET',
                token
            );

            const response = await downloadMediaGET(request, {
                params: Promise.resolve({ 'event-slug': 'test-event', 'media-id': '1' }),
            });

            expect(response.status).toBe(404);
            const text = await response.text();
            expect(text).toBe('Media not found');

            // Verify query included the hidden filter with isAdmin = false
            expect(queryMock).toHaveBeenCalledWith(
                expect.stringContaining('media.is_hidden = false OR $3 = true'),
                ['1', 'test-event', false]
            );
        });

        it('allows admin to download hidden media', async () => {
            const token = signToken(ADMIN_USER_ID, true);

            // Mock database query to return hidden media
            queryMock.mockResolvedValue({
                rows: [
                    {
                        media_id: 1,
                        content: 'https://blob.example.com/media.jpg',
                        type: 'image/jpeg',
                        event_id: 1,
                        is_hidden: true,
                    },
                ],
                command: 'SELECT',
                rowCount: 1,
                oid: 0,
                fields: [],
            });

            // Mock successful blob fetch
            const mockArrayBuffer = new ArrayBuffer(100);
            vi.mocked(global.fetch).mockResolvedValue({
                ok: true,
                arrayBuffer: async () => mockArrayBuffer,
            } as Response);

            const request = createRequest(
                'http://localhost/api/event/test-event/media/1/download',
                'GET',
                token
            );

            const response = await downloadMediaGET(request, {
                params: Promise.resolve({ 'event-slug': 'test-event', 'media-id': '1' }),
            });

            expect(response.status).toBe(200);
            expect(response.headers.get('Content-Type')).toBe('image/jpeg');

            // Verify query included the admin flag allowing access to hidden media
            expect(queryMock).toHaveBeenCalledWith(
                expect.stringContaining('media.is_hidden = false OR $3 = true'),
                ['1', 'test-event', true]
            );
        });

        it('allows non-admin to download visible media', async () => {
            const token = signToken(NON_ADMIN_USER_ID, false);

            // Mock database query to return visible media
            queryMock.mockResolvedValue({
                rows: [
                    {
                        media_id: 1,
                        content: 'https://blob.example.com/media.jpg',
                        type: 'image/jpeg',
                        event_id: 1,
                        is_hidden: false,
                    },
                ],
                command: 'SELECT',
                rowCount: 1,
                oid: 0,
                fields: [],
            });

            // Mock successful blob fetch
            const mockArrayBuffer = new ArrayBuffer(100);
            vi.mocked(global.fetch).mockResolvedValue({
                ok: true,
                arrayBuffer: async () => mockArrayBuffer,
            } as Response);

            const request = createRequest(
                'http://localhost/api/event/test-event/media/1/download',
                'GET',
                token
            );

            const response = await downloadMediaGET(request, {
                params: Promise.resolve({ 'event-slug': 'test-event', 'media-id': '1' }),
            });

            expect(response.status).toBe(200);
            expect(response.headers.get('Content-Type')).toBe('image/jpeg');
        });
    });

    describe('Likes endpoint (POST /api/event/[event-slug]/media/[media-id]/likes)', () => {
        it('returns 404 when non-admin tries to like hidden media', async () => {
            const token = signToken(NON_ADMIN_USER_ID, false);

            // Mock database query to return no results (hidden media filtered out)
            queryMock.mockResolvedValue({
                rows: [],
                command: 'SELECT',
                rowCount: 0,
                oid: 0,
                fields: [],
            });

            const request = createRequest(
                'http://localhost/api/event/test-event/media/1/likes',
                'POST',
                token
            );

            const response = await likeMediaPOST(request, {
                params: Promise.resolve({ 'event-slug': 'test-event', 'media-id': '1' }),
            });

            expect(response.status).toBe(404);
            const text = await response.text();
            expect(text).toBe('Media not found');

            // Verify query included the hidden filter with isAdmin = false
            expect(queryMock).toHaveBeenCalledWith(
                expect.stringContaining('media.is_hidden = false OR $3 = true'),
                ['1', 'test-event', false]
            );
        });

        it('allows admin to like hidden media', async () => {
            const token = signToken(ADMIN_USER_ID, true);

            // Mock database queries
            queryMock
                // First query: check media exists
                .mockResolvedValueOnce({
                    rows: [{ media_id: 1 }],
                    command: 'SELECT',
                    rowCount: 1,
                    oid: 0,
                    fields: [],
                })
                // Second query: check if already liked
                .mockResolvedValueOnce({
                    rows: [],
                    command: 'SELECT',
                    rowCount: 0,
                    oid: 0,
                    fields: [],
                })
                // Third query: insert like
                .mockResolvedValueOnce({
                    rows: [],
                    command: 'INSERT',
                    rowCount: 1,
                    oid: 0,
                    fields: [],
                })
                // Fourth query: count likes
                .mockResolvedValueOnce({
                    rows: [{ likes: '1' }],
                    command: 'SELECT',
                    rowCount: 1,
                    oid: 0,
                    fields: [],
                });

            const request = createRequest(
                'http://localhost/api/event/test-event/media/1/likes',
                'POST',
                token
            );

            const response = await likeMediaPOST(request, {
                params: Promise.resolve({ 'event-slug': 'test-event', 'media-id': '1' }),
            });

            expect(response.status).toBe(200);
            const json = await response.json();
            expect(json).toEqual({ liked: true, likes: 1 });

            // Verify first query included the admin flag
            expect(queryMock).toHaveBeenNthCalledWith(
                1,
                expect.stringContaining('media.is_hidden = false OR $3 = true'),
                ['1', 'test-event', true]
            );
        });
    });

    describe('Update media endpoint (PATCH /api/event/[event-slug]/media/[media-id])', () => {
        it('returns 404 when non-admin tries to update hidden media', async () => {
            const token = signToken(NON_ADMIN_USER_ID, false);

            // Mock database query to return no results (hidden media filtered out)
            queryMock.mockResolvedValue({
                rows: [],
                command: 'UPDATE',
                rowCount: 0,
                oid: 0,
                fields: [],
            });

            const request = createRequest(
                'http://localhost/api/event/test-event/media/1',
                'PATCH',
                token,
                { section_id: 2 }
            );

            const response = await updateMediaPATCH(request, {
                params: Promise.resolve({ 'event-slug': 'test-event', 'media-id': '1' }),
            });

            expect(response.status).toBe(404);
            const text = await response.text();
            expect(text).toBe('Media not found');

            // Verify query included the hidden filter (is_hidden = false)
            expect(queryMock).toHaveBeenCalledWith(
                expect.stringContaining('is_hidden = false'),
                expect.arrayContaining([2, '1', 'test-event', NON_ADMIN_USER_ID])
            );
        });

        it('allows admin to update hidden media', async () => {
            const token = signToken(ADMIN_USER_ID, true);

            // Mock database query to successfully update
            queryMock.mockResolvedValue({
                rows: [
                    {
                        media_id: 1,
                        user_id: 2,
                        content: 'https://blob.example.com/media.jpg',
                        media_type: 'image',
                        date: new Date(),
                        section_id: 2,
                        event_id: 1,
                        blurhash: null,
                        is_hidden: true,
                        hidden_at: new Date(),
                        hidden_by: 1,
                    },
                ],
                command: 'UPDATE',
                rowCount: 1,
                oid: 0,
                fields: [],
            });

            const request = createRequest(
                'http://localhost/api/event/test-event/media/1',
                'PATCH',
                token,
                { section_id: 2 }
            );

            const response = await updateMediaPATCH(request, {
                params: Promise.resolve({ 'event-slug': 'test-event', 'media-id': '1' }),
            });

            expect(response.status).toBe(200);
            const json = await response.json();
            expect(json.media_id).toBe(1);
            expect(json.is_hidden).toBe(true);

            // Verify query did NOT include the hidden filter (admins can update any media)
            expect(queryMock).toHaveBeenCalledWith(
                expect.not.stringContaining('is_hidden = false'),
                expect.arrayContaining([2, '1', 'test-event'])
            );
        });
    });
});
