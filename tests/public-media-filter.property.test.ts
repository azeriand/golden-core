// Property tests for public API filtering — Task 5.4
//
// **Property 5: Hidden Media Excluded from Public Views**
// For any media item with is_hidden = true, that item SHALL NOT appear in any
// public API response (event gallery feed).
// **Validates: Requirements 3.1, 3.2, 3.3**
//
// **Property 6: Direct Hidden Media Returns Not Found**
// For any hidden media item, when a non-administrator user requests that item
// directly by ID, the system SHALL return a 404 Not Found response.
// **Validates: Requirements 3.4**
//
// **Property 7: Public APIs Exclude Hidden State Field**
// For any public API response containing media items, the response SHALL NOT
// include the `is_hidden`, `hidden_at`, or `hidden_by` fields.
// **Validates: Requirements 3.5**
//
// Tests the real route handlers:
//   - GET /api/event/[event-slug]           (public gallery feed)
//   - GET /api/event/[event-slug]/media/[media-id]  (direct media access)
// External boundaries are mocked:
//   - `@/lib/db`         -> pool.query dispatched by SQL pattern
//   - `@/lib/demo-guard` -> always returns isDemoEvent=false
//   - `@/lib/sections`   -> real module (no mutation)
// REAL: `@/lib/auth` verifyRequest with actual signed JWT

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import jwt from 'jsonwebtoken';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Mock database before importing any routes
// ---------------------------------------------------------------------------
const { dbState } = vi.hoisted(() => {
    const dbState: { query: (sql: string, params?: unknown[]) => Promise<unknown> } = {
        query: async () => {
            throw new Error('dbState.query not initialised — call setModel() first');
        },
    };
    return { dbState };
});

vi.mock('@/lib/db', () => ({
    default: { query: (sql: string, params?: unknown[]) => dbState.query(sql, params) },
}));

vi.mock('@/lib/demo-guard', () => ({
    isDemoEvent: vi.fn(() => false),
    demoGuardResponse: vi.fn(),
    isDemoUser: vi.fn(() => false),
}));

// Import routes AFTER mocks are registered
import { GET as eventGET } from '@/app/api/event/[event-slug]/route';
import { GET as mediaGET } from '@/app/api/event/[event-slug]/media/[media-id]/route';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------
const TEST_SECRET = 'public-media-filter-property-test-secret';
const NON_ADMIN_USER_ID = 99;
const ADMIN_USER_ID = 42;
const EVENT_SLUG = 'test-event-2024';
const EVENT_ID = 7;

function signToken(userId: number, isAdmin: boolean): string {
    return jwt.sign(
        { userId, email: isAdmin ? 'admin@test.com' : 'user@test.com', isAdmin },
        TEST_SECRET,
        { expiresIn: '1h' }
    );
}

function createEventRequest(isAdmin: boolean): NextRequest {
    const url = `http://localhost/api/event/${EVENT_SLUG}`;
    const req = new NextRequest(url, { method: 'GET' });
    req.cookies.set('auth_token', signToken(isAdmin ? ADMIN_USER_ID : NON_ADMIN_USER_ID, isAdmin));
    return req;
}

function createMediaRequest(mediaId: number, isAdmin: boolean): NextRequest {
    const url = `http://localhost/api/event/${EVENT_SLUG}/media/${mediaId}`;
    const req = new NextRequest(url, { method: 'GET' });
    req.cookies.set('auth_token', signToken(isAdmin ? ADMIN_USER_ID : NON_ADMIN_USER_ID, isAdmin));
    return req;
}

// ---------------------------------------------------------------------------
// Data shapes
// ---------------------------------------------------------------------------
interface MediaRow {
    media_id: number;
    user_id: number;
    content: string;
    type: string;
    date: string;
    section_id: number | null;
    media_section_id: number | null;
    event_id: number;
    blurhash: string | null;
    width: number | null;
    height: number | null;
    poster_url: string | null;
    original_url: string | null;
    username: string;
    likes: number;
    liked: boolean;
    is_hidden: boolean;
    hidden_at: string | null;
    hidden_by: number | null;
}

// ---------------------------------------------------------------------------
// In-memory database model for GET /api/event/[event-slug]
// ---------------------------------------------------------------------------
// The event route fires two queries:
//   1. Big JOIN query for event + media + sections (pattern: SELECT events.event_id)
//   2. Sections-only query (pattern: SELECT s.section_id … FROM sections s WHERE …)
//
// For the JOIN query the route passes `$3 = isAdmin` to the LEFT JOIN condition:
//   LEFT JOIN media ON … AND (media.is_hidden = false OR $3 = true)
// Our model replicates that filtering logic.
function createEventModel(mediaItems: MediaRow[]) {
    const query = async (sql: string, params?: unknown[]): Promise<unknown> => {
        const p = params ?? [];
        const norm = sql.replace(/\s+/g, ' ').trim();

        // ── Big JOIN query ──────────────────────────────────────────────────
        if (/SELECT\s+events\.event_id/i.test(norm)) {
            const isAdmin = p[2] as boolean; // $3 in the query

            // Replicate: LEFT JOIN media ON … AND (media.is_hidden = false OR $3 = true)
            const visible = isAdmin
                ? mediaItems
                : mediaItems.filter(m => !m.is_hidden);

            // If no media rows at all, return a single event-only row so the
            // route doesn't treat the whole thing as "not found"
            if (visible.length === 0) {
                return {
                    rows: [{
                        event_id: EVENT_ID,
                        event_name: 'Test Event',
                        event_slug: EVENT_SLUG,
                        event_date: '2024-06-01',
                        event_cover_img: null,
                        section_id: null,
                        section_name: null,
                        start_date: null,
                        finish_date: null,
                        media_id: null,  // signals "no media" to the route
                        user_id: null,
                        media_section_id: null,
                        content: null,
                        date: null,
                        type: null,
                        blurhash: null,
                        width: null,
                        height: null,
                        poster_url: null,
                        original_url: null,
                        username: null,
                        likes: 0,
                        liked: false,
                    }],
                };
            }

            return {
                rows: visible.map(m => ({
                    event_id: EVENT_ID,
                    event_name: 'Test Event',
                    event_slug: EVENT_SLUG,
                    event_date: '2024-06-01',
                    event_cover_img: null,
                    section_id: m.section_id,
                    section_name: m.section_id ? `Section ${m.section_id}` : null,
                    start_date: null,
                    finish_date: null,
                    media_id: m.media_id,
                    user_id: m.user_id,
                    media_section_id: m.section_id,
                    content: m.content,
                    date: m.date,
                    type: m.type,
                    blurhash: m.blurhash,
                    width: m.width,
                    height: m.height,
                    poster_url: m.poster_url,
                    original_url: m.original_url,
                    username: m.username,
                    likes: m.likes,
                    liked: m.liked,
                })),
            };
        }

        // ── Sections-only query ────────────────────────────────────────────
        if (/FROM sections s\s+WHERE s\.event_id/i.test(norm)) {
            // Return sections present in the media set (deduplicated)
            const sectionIds = [...new Set(
                mediaItems
                    .filter(m => m.section_id !== null)
                    .map(m => m.section_id as number)
            )];
            return {
                rows: sectionIds.map(id => ({
                    section_id: id,
                    section_name: `Section ${id}`,
                    start_date: null,
                    finish_date: null,
                })),
            };
        }

        throw new Error(`Unexpected query in event model: ${norm.substring(0, 200)}`);
    };

    return { query };
}

// ---------------------------------------------------------------------------
// In-memory database model for GET /api/event/[event-slug]/media/[media-id]
// ---------------------------------------------------------------------------
// The route passes `$4 = isAdmin` and filters with:
//   AND (m.is_hidden = false OR $4 = true)
function createDirectMediaModel(targetMedia: MediaRow | null) {
    const query = async (sql: string, params?: unknown[]): Promise<unknown> => {
        const p = params ?? [];
        const norm = sql.replace(/\s+/g, ' ').trim();

        if (/SELECT.*m\.media_id.*FROM media m.*JOIN users u/i.test(norm)) {
            const isAdmin = p[3] as boolean; // $4

            // Return no rows if media is hidden and caller is not admin
            if (!targetMedia) return { rows: [] };
            if (targetMedia.is_hidden && !isAdmin) return { rows: [] };

            return {
                rows: [{
                    media_id: targetMedia.media_id,
                    user_id: targetMedia.user_id,
                    content: targetMedia.content,
                    type: targetMedia.type,
                    date: targetMedia.date,
                    section_id: targetMedia.section_id,
                    blurhash: targetMedia.blurhash,
                    width: targetMedia.width,
                    height: targetMedia.height,
                    poster_url: targetMedia.poster_url,
                    original_url: targetMedia.original_url,
                    username: targetMedia.username,
                    likes: targetMedia.likes,
                    liked: targetMedia.liked,
                    // Deliberately excluded from public DTO — included here to
                    // simulate a real DB row that could leak if the handler is buggy
                    is_hidden: targetMedia.is_hidden,
                    hidden_at: targetMedia.hidden_at,
                    hidden_by: targetMedia.hidden_by,
                }],
            };
        }

        throw new Error(`Unexpected query in direct-media model: ${norm.substring(0, 200)}`);
    };

    return { query };
}

// ---------------------------------------------------------------------------
// fast-check generators
// ---------------------------------------------------------------------------
const baseMediaArb = fc.record({
    user_id: fc.integer({ min: 1, max: 100 }),
    content: fc.webUrl(),
    type: fc.constantFrom('image/jpeg', 'image/png', 'video/mp4'),
    date: fc
        .integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2025, 0, 1) })
        .map(ms => new Date(ms).toISOString()),
    section_id: fc.option(fc.integer({ min: 1, max: 10 }), { nil: null }),
    blurhash: fc.option(fc.string({ minLength: 12, maxLength: 12 }), { nil: null }),
    poster_url: fc.option(fc.webUrl(), { nil: null }),
    original_url: fc.option(fc.webUrl(), { nil: null }),
    width: fc.option(fc.integer({ min: 100, max: 4000 }), { nil: null }),
    height: fc.option(fc.integer({ min: 100, max: 4000 }), { nil: null }),
    is_hidden: fc.boolean(),
    username: fc.stringMatching(/^[a-z]{3,10}$/),
    likes: fc.integer({ min: 0, max: 100 }),
    liked: fc.boolean(),
});

// Collection of media items with sequential unique IDs
const mediaCollectionArb: fc.Arbitrary<MediaRow[]> = fc
    .array(baseMediaArb, { minLength: 1, maxLength: 30 })
    .map(items =>
        items.map((item, index): MediaRow => ({
            ...item,
            media_id: index + 1,
            media_section_id: item.section_id,
            event_id: EVENT_ID,
            hidden_at: item.is_hidden ? new Date().toISOString() : null,
            hidden_by: item.is_hidden ? ADMIN_USER_ID : null,
        }))
    );

// A single hidden media item
const hiddenMediaArb: fc.Arbitrary<MediaRow> = baseMediaArb.map(
    (item, _): MediaRow => ({
        ...item,
        media_id: 500,
        media_section_id: item.section_id,
        event_id: EVENT_ID,
        is_hidden: true,
        hidden_at: new Date().toISOString(),
        hidden_by: ADMIN_USER_ID,
    })
);

// ---------------------------------------------------------------------------
// Environment setup
// ---------------------------------------------------------------------------
const originalSecret = process.env.JWT_SECRET;

beforeEach(() => {
    process.env.JWT_SECRET = TEST_SECRET;
});

afterEach(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

const NUM_RUNS = 100;

// ============================================================================
// Property 5: Hidden Media Excluded from Public Views
// Validates: Requirements 3.1, 3.2, 3.3
// ============================================================================
describe('Property 5: Hidden Media Excluded from Public Views', () => {
    it('public event gallery never contains hidden media items', async () => {
        await fc.assert(
            fc.asyncProperty(mediaCollectionArb, async (mediaItems) => {
                // Only interesting when there is at least one hidden item to check
                fc.pre(mediaItems.some(m => m.is_hidden));

                const model = createEventModel(mediaItems);
                dbState.query = model.query;

                const response = await eventGET(
                    createEventRequest(false), // non-admin
                    { params: Promise.resolve({ 'event-slug': EVENT_SLUG }) }
                );

                expect(response.status).toBe(200);
                const body = await response.json();

                // Collect all media items across every section
                const allReturnedMedia: unknown[] = [];
                for (const section of body.sections) {
                    allReturnedMedia.push(...section.media);
                }

                // P5 CORE: No hidden item may appear in a public response
                const hiddenIds = new Set(
                    mediaItems.filter(m => m.is_hidden).map(m => m.media_id)
                );

                for (const item of allReturnedMedia as Array<{ media_id: number }>) {
                    expect(hiddenIds.has(item.media_id)).toBe(false);
                }
            }),
            { numRuns: NUM_RUNS }
        );
    });

    it('every visible item IS present in public event gallery', async () => {
        await fc.assert(
            fc.asyncProperty(mediaCollectionArb, async (mediaItems) => {
                // Need at least one visible item
                fc.pre(mediaItems.some(m => !m.is_hidden));

                const model = createEventModel(mediaItems);
                dbState.query = model.query;

                const response = await eventGET(
                    createEventRequest(false),
                    { params: Promise.resolve({ 'event-slug': EVENT_SLUG }) }
                );

                expect(response.status).toBe(200);
                const body = await response.json();

                const allReturnedMedia: Array<{ media_id: number }> = [];
                for (const section of body.sections) {
                    allReturnedMedia.push(...section.media);
                }
                const returnedIds = new Set(allReturnedMedia.map(m => m.media_id));

                // Every visible item must appear in the response
                const visibleItems = mediaItems.filter(m => !m.is_hidden);
                for (const item of visibleItems) {
                    expect(returnedIds.has(item.media_id)).toBe(true);
                }
            }),
            { numRuns: NUM_RUNS }
        );
    });

    it('admin sees all items (hidden and visible) in event gallery', async () => {
        await fc.assert(
            fc.asyncProperty(mediaCollectionArb, async (mediaItems) => {
                fc.pre(mediaItems.some(m => m.is_hidden));

                const model = createEventModel(mediaItems);
                dbState.query = model.query;

                const response = await eventGET(
                    createEventRequest(true), // admin
                    { params: Promise.resolve({ 'event-slug': EVENT_SLUG }) }
                );

                expect(response.status).toBe(200);
                const body = await response.json();

                const allReturnedMedia: Array<{ media_id: number }> = [];
                for (const section of body.sections) {
                    allReturnedMedia.push(...section.media);
                }
                const returnedIds = new Set(allReturnedMedia.map(m => m.media_id));

                // Admin should see every item including hidden ones
                for (const item of mediaItems) {
                    expect(returnedIds.has(item.media_id)).toBe(true);
                }
            }),
            { numRuns: NUM_RUNS }
        );
    });
});

// ============================================================================
// Property 6: Direct Hidden Media Returns Not Found
// Validates: Requirements 3.4
// ============================================================================
describe('Property 6: Direct Hidden Media Returns Not Found', () => {
    it('non-admin requesting a hidden media item by ID always gets 404', async () => {
        await fc.assert(
            fc.asyncProperty(hiddenMediaArb, async (hiddenMedia) => {
                const model = createDirectMediaModel(hiddenMedia);
                dbState.query = model.query;

                const response = await mediaGET(
                    createMediaRequest(hiddenMedia.media_id, false), // non-admin
                    {
                        params: Promise.resolve({
                            'event-slug': EVENT_SLUG,
                            'media-id': String(hiddenMedia.media_id),
                        }),
                    }
                );

                // P6 CORE: non-admin must receive 404, not 200 or 403
                expect(response.status).toBe(404);
            }),
            { numRuns: NUM_RUNS }
        );
    });

    it('admin requesting a hidden media item by ID gets 200', async () => {
        await fc.assert(
            fc.asyncProperty(hiddenMediaArb, async (hiddenMedia) => {
                const model = createDirectMediaModel(hiddenMedia);
                dbState.query = model.query;

                const response = await mediaGET(
                    createMediaRequest(hiddenMedia.media_id, true), // admin
                    {
                        params: Promise.resolve({
                            'event-slug': EVENT_SLUG,
                            'media-id': String(hiddenMedia.media_id),
                        }),
                    }
                );

                // Admins CAN access hidden media directly
                expect(response.status).toBe(200);
            }),
            { numRuns: NUM_RUNS }
        );
    });
});

// ============================================================================
// Property 7: Public APIs Exclude Hidden State Field
// Validates: Requirements 3.5
// ============================================================================

// The three fields that must NEVER appear in public responses
const HIDDEN_STATE_FIELDS = ['is_hidden', 'hidden_at', 'hidden_by'] as const;

describe('Property 7: Public APIs Exclude Hidden State Field', () => {
    it('event gallery media items never contain is_hidden, hidden_at, or hidden_by', async () => {
        await fc.assert(
            fc.asyncProperty(mediaCollectionArb, async (mediaItems) => {
                fc.pre(mediaItems.some(m => !m.is_hidden)); // at least one visible item

                const model = createEventModel(mediaItems);
                dbState.query = model.query;

                const response = await eventGET(
                    createEventRequest(false),
                    { params: Promise.resolve({ 'event-slug': EVENT_SLUG }) }
                );

                expect(response.status).toBe(200);
                const body = await response.json();

                for (const section of body.sections) {
                    for (const item of section.media as Record<string, unknown>[]) {
                        for (const field of HIDDEN_STATE_FIELDS) {
                            // P7 CORE: field must be completely absent from the object
                            expect(Object.prototype.hasOwnProperty.call(item, field)).toBe(false);
                        }
                    }
                }
            }),
            { numRuns: NUM_RUNS }
        );
    });

    it('direct media access response never contains is_hidden, hidden_at, or hidden_by', async () => {
        await fc.assert(
            fc.asyncProperty(
                baseMediaArb.map((item): MediaRow => ({
                    ...item,
                    media_id: 200,
                    media_section_id: item.section_id,
                    event_id: EVENT_ID,
                    is_hidden: false, // visible — non-admin can fetch it
                    hidden_at: null,
                    hidden_by: null,
                })),
                async (visibleMedia) => {
                    const model = createDirectMediaModel(visibleMedia);
                    dbState.query = model.query;

                    const response = await mediaGET(
                        createMediaRequest(visibleMedia.media_id, false),
                        {
                            params: Promise.resolve({
                                'event-slug': EVENT_SLUG,
                                'media-id': String(visibleMedia.media_id),
                            }),
                        }
                    );

                    expect(response.status).toBe(200);
                    const body = await response.json() as Record<string, unknown>;

                    for (const field of HIDDEN_STATE_FIELDS) {
                        // P7 CORE: none of the three fields may appear
                        expect(Object.prototype.hasOwnProperty.call(body, field)).toBe(false);
                    }
                }
            ),
            { numRuns: NUM_RUNS }
        );
    });

    it('admin event gallery also omits hidden state fields in media items', async () => {
        // Even though admins can SEE hidden items, the response DTO still must
        // not expose the visibility metadata in the public route response shape.
        await fc.assert(
            fc.asyncProperty(mediaCollectionArb, async (mediaItems) => {
                const model = createEventModel(mediaItems);
                dbState.query = model.query;

                const response = await eventGET(
                    createEventRequest(true), // admin
                    { params: Promise.resolve({ 'event-slug': EVENT_SLUG }) }
                );

                expect(response.status).toBe(200);
                const body = await response.json();

                for (const section of body.sections) {
                    for (const item of section.media as Record<string, unknown>[]) {
                        for (const field of HIDDEN_STATE_FIELDS) {
                            expect(Object.prototype.hasOwnProperty.call(item, field)).toBe(false);
                        }
                    }
                }
            }),
            { numRuns: NUM_RUNS }
        );
    });
});
