// Property tests for GET /api/admin/media — Task 3.4
//
// **Property 3: Admin API Includes Visibility State**
// For any admin API response containing media items, each media item SHALL
// include the `is_hidden` attribute.
// **Validates: Requirements 2.4**
//
// **Property 4: Visibility Filter Correctness**
// For any collection of media items with mixed visibility states, when
// filtered by a specific visibility state (hidden or visible), the result
// SHALL contain only items matching that state.
// **Validates: Requirements 2.3**
//
// Tests the real GET /api/admin/media route handler.
// - `@/lib/db` pool.query is mocked with an in-memory collection model
// - `@/lib/auth` verifyRequest uses real JWT verification

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import jwt from 'jsonwebtoken';
import { NextRequest } from 'next/server';

// --- Mock database before importing route -----------------------------------
const { dbState } = vi.hoisted(() => {
    const dbState: { query: (sql: string, params?: unknown[]) => Promise<unknown> } = {
        query: async () => {
            throw new Error('db model not initialised');
        },
    };
    return { dbState };
});

vi.mock('@/lib/db', () => ({
    default: { query: (sql: string, params?: unknown[]) => dbState.query(sql, params) },
}));

// Import AFTER mocks are registered
import { GET } from '@/app/api/admin/media/route';

// --- Test fixtures ----------------------------------------------------------
const TEST_SECRET = 'admin-media-filter-property-test-secret';
const ADMIN_USER_ID = 42;
const EVENT_ID = 1;

function signAdminToken(): string {
    return jwt.sign(
        { userId: ADMIN_USER_ID, email: 'admin@test.com', isAdmin: true },
        TEST_SECRET,
        { expiresIn: '1h' }
    );
}

function createRequest(queryParams: Record<string, string>): NextRequest {
    const params = new URLSearchParams(queryParams);
    const url = `http://localhost/api/admin/media?${params.toString()}`;
    const req = new NextRequest(url, { method: 'GET' });
    req.cookies.set('auth_token', signAdminToken());
    return req;
}

interface MediaRow {
    media_id: number;
    user_id: number;
    content: string;
    type: string;
    date: string;
    section_id: number | null;
    blurhash: string | null;
    poster_url: string | null;
    original_url: string | null;
    width: number;
    height: number;
    is_hidden: boolean;
    hidden_at: string | null;
    hidden_by: number | null;
    username: string;
    likes: number;
    liked: boolean;
    hidden_by_username: string | null;
}

// --- In-memory media collection model ---------------------------------------
// Simulates the DB query responses based on SQL pattern matching.
function createMediaModel(mediaItems: MediaRow[]) {
    async function query(sql: string, params?: unknown[]): Promise<unknown> {
        const p = params ?? [];
        const normalized = sql.replace(/\s+/g, ' ').trim();

        // Main media query
        if (/SELECT.*m\.media_id.*FROM media m.*JOIN users u/i.test(normalized)) {
            let filtered = [...mediaItems];

            if (/m\.is_hidden\s*=\s*true/i.test(normalized)) {
                filtered = filtered.filter(m => m.is_hidden === true);
            } else if (/m\.is_hidden\s*=\s*false/i.test(normalized)) {
                filtered = filtered.filter(m => m.is_hidden === false);
            }

            // Apply pagination (last two params: limit, offset)
            const limit = p[p.length - 2] as number;
            const offset = p[p.length - 1] as number;
            const paginated = filtered.slice(offset, offset + limit);

            return { rows: paginated };
        }

        // Count query
        if (/SELECT\s+COUNT\(\*\)\s+AS\s+total/i.test(normalized)) {
            let filtered = [...mediaItems];

            if (/m\.is_hidden\s*=\s*true/i.test(normalized)) {
                filtered = filtered.filter(m => m.is_hidden === true);
            } else if (/m\.is_hidden\s*=\s*false/i.test(normalized)) {
                filtered = filtered.filter(m => m.is_hidden === false);
            }

            return { rows: [{ total: String(filtered.length) }] };
        }

        throw new Error(`Unexpected query in admin-media-filter property test: ${normalized.substring(0, 200)}`);
    }

    return { query };
}

// --- fast-check generators --------------------------------------------------

// Single media item with an explicit unique ID slot (filled by the collection generator)
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
    width: fc.integer({ min: 100, max: 4000 }),
    height: fc.integer({ min: 100, max: 4000 }),
    is_hidden: fc.boolean(),
    username: fc.stringMatching(/^[a-z]{3,10}$/),
    likes: fc.integer({ min: 0, max: 100 }),
    liked: fc.boolean(),
});

// Generate a collection of media items with guaranteed-unique media_ids so
// that set-intersection checks on IDs are always meaningful.
const mediaCollectionArb: fc.Arbitrary<MediaRow[]> = fc
    .array(baseMediaArb, { minLength: 1, maxLength: 50 })
    .map(items =>
        items.map((item, index): MediaRow => ({
            ...item,
            media_id: index + 1, // unique sequential IDs
            hidden_at: item.is_hidden ? new Date().toISOString() : null,
            hidden_by: item.is_hidden ? ADMIN_USER_ID : null,
            hidden_by_username: item.is_hidden ? 'admin_user' : null,
        }))
    );

// --- Environment setup ------------------------------------------------------
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
// Property 3: Admin API Includes Visibility State
// Validates: Requirements 2.4
// ============================================================================
describe('Property 3: Admin API Includes Visibility State', () => {
    it('every media item in admin response includes the is_hidden attribute', async () => {
        await fc.assert(
            fc.asyncProperty(mediaCollectionArb, async (mediaItems) => {
                const model = createMediaModel(mediaItems);
                dbState.query = model.query;

                const response = await GET(createRequest({ event_id: String(EVENT_ID) }));

                expect(response.status).toBe(200);
                const body = await response.json();

                expect(body.media).toBeDefined();
                expect(Array.isArray(body.media)).toBe(true);

                for (const item of body.media) {
                    // Core: is_hidden MUST be present and be a boolean
                    expect(item).toHaveProperty('is_hidden');
                    expect(typeof item.is_hidden).toBe('boolean');

                    // Supporting visibility metadata must also be present
                    expect(item).toHaveProperty('hidden_at');
                    expect(item).toHaveProperty('hidden_by');
                    expect(item).toHaveProperty('hidden_by_username');

                    // Consistency: hidden items must carry non-null metadata
                    if (item.is_hidden === true) {
                        expect(item.hidden_at).not.toBeNull();
                        expect(item.hidden_by).not.toBeNull();
                    }
                }
            }),
            { numRuns: NUM_RUNS }
        );
    });
});

// ============================================================================
// Property 4: Visibility Filter Correctness
// Validates: Requirements 2.3
// ============================================================================
describe('Property 4: Visibility Filter Correctness', () => {
    it('hidden=true returns only hidden items', async () => {
        await fc.assert(
            fc.asyncProperty(mediaCollectionArb, async (mediaItems) => {
                // Only run when there are hidden items to filter
                fc.pre(mediaItems.some(m => m.is_hidden));

                const model = createMediaModel(mediaItems);
                dbState.query = model.query;

                const response = await GET(
                    createRequest({ event_id: String(EVENT_ID), hidden: 'true' })
                );

                expect(response.status).toBe(200);
                const body = await response.json();

                // Every returned item must be hidden
                for (const item of body.media) {
                    expect(item.is_hidden).toBe(true);
                }

                // Total must match the number of hidden items in the input
                const expectedCount = mediaItems.filter(m => m.is_hidden).length;
                expect(body.total).toBe(expectedCount);
            }),
            { numRuns: NUM_RUNS }
        );
    });

    it('hidden=false returns only visible items', async () => {
        await fc.assert(
            fc.asyncProperty(mediaCollectionArb, async (mediaItems) => {
                // Only run when there are visible items to filter
                fc.pre(mediaItems.some(m => !m.is_hidden));

                const model = createMediaModel(mediaItems);
                dbState.query = model.query;

                const response = await GET(
                    createRequest({ event_id: String(EVENT_ID), hidden: 'false' })
                );

                expect(response.status).toBe(200);
                const body = await response.json();

                // Every returned item must be visible
                for (const item of body.media) {
                    expect(item.is_hidden).toBe(false);
                }

                // Total must match the number of visible items in the input
                const expectedCount = mediaItems.filter(m => !m.is_hidden).length;
                expect(body.total).toBe(expectedCount);
            }),
            { numRuns: NUM_RUNS }
        );
    });

    it('hidden=all returns items regardless of visibility', async () => {
        await fc.assert(
            fc.asyncProperty(mediaCollectionArb, async (mediaItems) => {
                const model = createMediaModel(mediaItems);
                dbState.query = model.query;

                const response = await GET(
                    createRequest({ event_id: String(EVENT_ID), hidden: 'all' })
                );

                expect(response.status).toBe(200);
                const body = await response.json();

                // Total must match all items in the input
                expect(body.total).toBe(mediaItems.length);

                // If the input contains hidden items, the response must too
                if (mediaItems.some(m => m.is_hidden)) {
                    expect(body.media.some((m: MediaRow) => m.is_hidden === true)).toBe(true);
                }
                // If the input contains visible items, the response must too
                if (mediaItems.some(m => !m.is_hidden)) {
                    expect(body.media.some((m: MediaRow) => m.is_hidden === false)).toBe(true);
                }
            }),
            { numRuns: NUM_RUNS }
        );
    });

    it('filter consistency: hidden + visible counts equal all', async () => {
        await fc.assert(
            fc.asyncProperty(mediaCollectionArb, async (mediaItems) => {
                // Require both kinds of items for a non-trivial consistency check
                fc.pre(mediaItems.some(m => m.is_hidden) && mediaItems.some(m => !m.is_hidden));

                const model = createMediaModel(mediaItems);
                dbState.query = model.query;

                const [allResp, hiddenResp, visibleResp] = await Promise.all([
                    GET(createRequest({ event_id: String(EVENT_ID), hidden: 'all' })),
                    GET(createRequest({ event_id: String(EVENT_ID), hidden: 'true' })),
                    GET(createRequest({ event_id: String(EVENT_ID), hidden: 'false' })),
                ]);

                const allBody    = await allResp.json();
                const hiddenBody = await hiddenResp.json();
                const visibleBody = await visibleResp.json();

                // Totals must add up
                expect(hiddenBody.total + visibleBody.total).toBe(allBody.total);
                expect(hiddenBody.media.length + visibleBody.media.length).toBe(allBody.media.length);

                // The hidden set and visible set must be disjoint by media_id.
                // This relies on unique media_ids guaranteed by the generator.
                const hiddenIds  = new Set(hiddenBody.media.map((m: MediaRow) => m.media_id));
                const visibleIds = new Set(visibleBody.media.map((m: MediaRow) => m.media_id));

                for (const id of hiddenIds) {
                    expect(visibleIds.has(id)).toBe(false);
                }
            }),
            { numRuns: NUM_RUNS }
        );
    });
});
