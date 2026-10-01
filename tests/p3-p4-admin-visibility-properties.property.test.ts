// Property tests P3 & P4 — Admin API visibility state inclusion — Task 3.4
//
// Property 3: Admin API Includes Visibility State
//   For any admin API response containing media items, each media item SHALL
//   include the `is_hidden` attribute.
//   **Validates: Requirements 2.4**
//
// Property 4: Visibility Filter Correctness
//   For any collection of media items with mixed visibility states, when
//   filtered by a specific visibility state (hidden or visible), the result
//   SHALL contain only items matching that state.
//   **Validates: Requirements 2.3**
//
// This is a UNIT-level property test against the real GET /api/admin/media
// route handler. External boundaries are mocked:
//   - `@/lib/db` -> pool.query, dispatched by SQL pattern to an in-memory
//                   media collection model
// REAL: `@/lib/auth` verifyRequest with actual signed JWT

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
const TEST_SECRET = 'p3-p4-property-test-secret';
const ADMIN_USER_ID = 42;
const EVENT_ID = 1;

function signToken(userId: number, isAdmin: boolean): string {
    return jwt.sign(
        { userId, email: isAdmin ? 'admin@test.com' : 'user@test.com', isAdmin },
        TEST_SECRET,
        { expiresIn: '1h' }
    );
}

function createRequest(queryParams: Record<string, string>, token: string): NextRequest {
    const params = new URLSearchParams(queryParams);
    const url = `http://localhost/api/admin/media?${params.toString()}`;
    const req = new NextRequest(url, {
        method: 'GET',
        headers: {},
    });
    req.cookies.set('auth_token', token);
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
interface MediaCollectionModel {
    query: (sql: string, params?: unknown[]) => Promise<unknown>;
    allMedia: () => MediaRow[];
}

function createMediaCollectionModel(mediaItems: MediaRow[]): MediaCollectionModel {
    async function query(sql: string, params?: unknown[]): Promise<unknown> {
        const p = params ?? [];
        
        // Normalize SQL for matching (remove extra whitespace/newlines)
        const normalizedSql = sql.replace(/\s+/g, ' ').trim();
        
        // Main media query with admin metadata
        if (/SELECT.*m\.media_id.*FROM media m.*JOIN users u/i.test(normalizedSql)) {
            // Extract filter parameters
            // Expected params order: [eventId, ...filters, userId, limit, offset]
            // We need to parse the WHERE clause to determine filters
            const eventId = p[0] as number;
            let filtered = [...mediaItems]; // all media
            
            // Check for visibility filter in SQL
            if (/m\.is_hidden\s*=\s*true/i.test(normalizedSql)) {
                filtered = filtered.filter(m => m.is_hidden === true);
            } else if (/m\.is_hidden\s*=\s*false/i.test(normalizedSql)) {
                filtered = filtered.filter(m => m.is_hidden === false);
            }
            
            // Check for section_id filter
            if (/m\.section_id\s*=\s*\$/i.test(normalizedSql)) {
                // Find section_id in params (it's after eventId but before userId, limit, offset)
                // Count $ placeholders before section_id to find its position
                const sectionIdMatch = normalizedSql.match(/m\.section_id\s*=\s*\$(\d+)/);
                if (sectionIdMatch) {
                    const sectionParamIndex = parseInt(sectionIdMatch[1], 10) - 1;
                    const sectionId = p[sectionParamIndex] as number;
                    filtered = filtered.filter(m => m.section_id === sectionId);
                }
            }
            
            // Apply pagination (last two params are limit and offset)
            const limit = p[p.length - 2] as number;
            const offset = p[p.length - 1] as number;
            const paginated = filtered.slice(offset, offset + limit);
            
            return { rows: paginated };
        }
        
        // Count query for pagination
        if (/SELECT\s+COUNT\(\*\)\s+AS\s+total/i.test(normalizedSql)) {
            const eventId = p[0] as number;
            let filtered = [...mediaItems]; // all media
            
            // Apply same filters as main query
            if (/m\.is_hidden\s*=\s*true/i.test(normalizedSql)) {
                filtered = filtered.filter(m => m.is_hidden === true);
            } else if (/m\.is_hidden\s*=\s*false/i.test(normalizedSql)) {
                filtered = filtered.filter(m => m.is_hidden === false);
            }
            
            if (/m\.section_id\s*=\s*\$/i.test(normalizedSql)) {
                const sectionIdMatch = normalizedSql.match(/m\.section_id\s*=\s*\$(\d+)/);
                if (sectionIdMatch) {
                    const sectionParamIndex = parseInt(sectionIdMatch[1], 10) - 1;
                    const sectionId = p[sectionParamIndex] as number;
                    filtered = filtered.filter(m => m.section_id === sectionId);
                }
            }
            
            return { rows: [{ total: String(filtered.length) }] };
        }
        
        throw new Error(`Unexpected query in P3/P4 model: ${normalizedSql.substring(0, 200)}`);
    }
    
    return {
        query,
        allMedia: () => [...mediaItems],
    };
}

// --- fast-check generators --------------------------------------------------

// Generator for a single media item without an ID (ID assigned by collection generator)
const baseMediaItemArb = fc.record({
    user_id: fc.integer({ min: 1, max: 100 }),
    content: fc.webUrl(),
    type: fc.constantFrom('image/jpeg', 'image/png', 'video/mp4'),
    date: fc.integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2025, 0, 1) })
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

// Generator for a collection of media items with guaranteed-unique media_ids.
// Unique IDs are required for set-intersection checks (Property 4 consistency).
const mediaCollectionArb: fc.Arbitrary<MediaRow[]> = fc
    .array(baseMediaItemArb, { minLength: 1, maxLength: 50 })
    .map(items =>
        items.map((item, index): MediaRow => ({
            ...item,
            media_id: index + 1, // sequential, unique
            hidden_at: item.is_hidden ? new Date().toISOString() : null,
            hidden_by: item.is_hidden ? ADMIN_USER_ID : null,
            hidden_by_username: item.is_hidden ? 'admin_user' : null,
        }))
    );

// Generator for visibility filter values
const visibilityFilterArb = fc.constantFrom('all', 'true', 'false');

const originalSecret = process.env.JWT_SECRET;

beforeEach(() => {
    process.env.JWT_SECRET = TEST_SECRET;
});

afterEach(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

const NUM_RUNS = 100;

describe('P3 & P4 — Admin API visibility state properties', () => {
    describe('Property 3: Admin API Includes Visibility State', () => {
        it('every media item in admin response includes is_hidden attribute', async () => {
            await fc.assert(
                fc.asyncProperty(mediaCollectionArb, async (mediaItems) => {
                    // Per-run isolation: fresh model
                    const model = createMediaCollectionModel(mediaItems);
                    dbState.query = model.query;
                    
                    const token = signToken(ADMIN_USER_ID, true);
                    const request = createRequest({ event_id: String(EVENT_ID) }, token);
                    
                    const response = await GET(request);
                    
                    expect(response.status).toBe(200);
                    const body = await response.json();
                    
                    // P3 CORE: Every media item MUST have is_hidden attribute
                    expect(body.media).toBeDefined();
                    expect(Array.isArray(body.media)).toBe(true);
                    
                    for (const mediaItem of body.media) {
                        // Each item must have the is_hidden property
                        expect(mediaItem).toHaveProperty('is_hidden');
                        expect(typeof mediaItem.is_hidden).toBe('boolean');
                        
                        // Additionally verify other visibility metadata exists
                        // (they can be null for visible items)
                        expect(mediaItem).toHaveProperty('hidden_at');
                        expect(mediaItem).toHaveProperty('hidden_by');
                        expect(mediaItem).toHaveProperty('hidden_by_username');
                        
                        // Validate consistency: if hidden, metadata should be present
                        if (mediaItem.is_hidden) {
                            expect(mediaItem.hidden_at).not.toBeNull();
                            expect(mediaItem.hidden_by).not.toBeNull();
                        }
                    }
                }),
                { numRuns: NUM_RUNS },
            );
        });
    });
    
    describe('Property 4: Visibility Filter Correctness', () => {
        it('hidden=true filter returns only hidden items', async () => {
            await fc.assert(
                fc.asyncProperty(mediaCollectionArb, async (mediaItems) => {
                    // Ensure we have at least some hidden items for meaningful test
                    const hiddenCount = mediaItems.filter(m => m.is_hidden).length;
                    fc.pre(hiddenCount > 0); // Skip runs with no hidden items
                    
                    const model = createMediaCollectionModel(mediaItems);
                    dbState.query = model.query;
                    
                    const token = signToken(ADMIN_USER_ID, true);
                    const request = createRequest({ 
                        event_id: String(EVENT_ID),
                        hidden: 'true'
                    }, token);
                    
                    const response = await GET(request);
                    
                    expect(response.status).toBe(200);
                    const body = await response.json();
                    
                    // P4 CORE: All returned items MUST have is_hidden = true
                    expect(body.media).toBeDefined();
                    expect(Array.isArray(body.media)).toBe(true);
                    
                    for (const mediaItem of body.media) {
                        expect(mediaItem.is_hidden).toBe(true);
                    }
                    
                    // Verify count matches expected hidden items
                    const expectedHidden = mediaItems.filter(m => m.is_hidden);
                    expect(body.total).toBe(expectedHidden.length);
                }),
                { numRuns: NUM_RUNS },
            );
        });
        
        it('hidden=false filter returns only visible items', async () => {
            await fc.assert(
                fc.asyncProperty(mediaCollectionArb, async (mediaItems) => {
                    // Ensure we have at least some visible items
                    const visibleCount = mediaItems.filter(m => !m.is_hidden).length;
                    fc.pre(visibleCount > 0); // Skip runs with no visible items
                    
                    const model = createMediaCollectionModel(mediaItems);
                    dbState.query = model.query;
                    
                    const token = signToken(ADMIN_USER_ID, true);
                    const request = createRequest({ 
                        event_id: String(EVENT_ID),
                        hidden: 'false'
                    }, token);
                    
                    const response = await GET(request);
                    
                    expect(response.status).toBe(200);
                    const body = await response.json();
                    
                    // P4 CORE: All returned items MUST have is_hidden = false
                    expect(body.media).toBeDefined();
                    expect(Array.isArray(body.media)).toBe(true);
                    
                    for (const mediaItem of body.media) {
                        expect(mediaItem.is_hidden).toBe(false);
                    }
                    
                    // Verify count matches expected visible items
                    const expectedVisible = mediaItems.filter(m => !m.is_hidden);
                    expect(body.total).toBe(expectedVisible.length);
                }),
                { numRuns: NUM_RUNS },
            );
        });
        
        it('hidden=all filter returns all items regardless of visibility', async () => {
            await fc.assert(
                fc.asyncProperty(mediaCollectionArb, async (mediaItems) => {
                    const model = createMediaCollectionModel(mediaItems);
                    dbState.query = model.query;
                    
                    const token = signToken(ADMIN_USER_ID, true);
                    const request = createRequest({ 
                        event_id: String(EVENT_ID),
                        hidden: 'all'
                    }, token);
                    
                    const response = await GET(request);
                    
                    expect(response.status).toBe(200);
                    const body = await response.json();
                    
                    // P4 EXTENDED: 'all' filter should return both hidden and visible
                    expect(body.media).toBeDefined();
                    expect(Array.isArray(body.media)).toBe(true);
                    
                    // Should include items with both is_hidden values
                    const hasHidden = body.media.some((m: MediaRow) => m.is_hidden === true);
                    const hasVisible = body.media.some((m: MediaRow) => m.is_hidden === false);
                    
                    // At least one of each should exist if the collection has both
                    const inputHasHidden = mediaItems.some(m => m.is_hidden);
                    const inputHasVisible = mediaItems.some(m => !m.is_hidden);
                    
                    if (inputHasHidden) expect(hasHidden).toBe(true);
                    if (inputHasVisible) expect(hasVisible).toBe(true);
                    
                    // Total count should match all items
                    expect(body.total).toBe(mediaItems.length);
                }),
                { numRuns: NUM_RUNS },
            );
        });
        
        it('filter consistency: union of hidden+visible equals all', async () => {
            await fc.assert(
                fc.asyncProperty(mediaCollectionArb, async (mediaItems) => {
                    // Ensure we have both types for meaningful test
                    const hiddenCount = mediaItems.filter(m => m.is_hidden).length;
                    const visibleCount = mediaItems.filter(m => !m.is_hidden).length;
                    fc.pre(hiddenCount > 0 && visibleCount > 0);
                    
                    const model = createMediaCollectionModel(mediaItems);
                    dbState.query = model.query;
                    
                    const token = signToken(ADMIN_USER_ID, true);
                    
                    // Query all three filter states
                    const allRequest = createRequest({ 
                        event_id: String(EVENT_ID),
                        hidden: 'all'
                    }, token);
                    
                    const hiddenRequest = createRequest({ 
                        event_id: String(EVENT_ID),
                        hidden: 'true'
                    }, token);
                    
                    const visibleRequest = createRequest({ 
                        event_id: String(EVENT_ID),
                        hidden: 'false'
                    }, token);
                    
                    const [allResp, hiddenResp, visibleResp] = await Promise.all([
                        GET(allRequest),
                        GET(hiddenRequest),
                        GET(visibleRequest)
                    ]);
                    
                    const allBody = await allResp.json();
                    const hiddenBody = await hiddenResp.json();
                    const visibleBody = await visibleResp.json();
                    
                    // P4 CONSISTENCY: hidden + visible = all
                    expect(hiddenBody.total + visibleBody.total).toBe(allBody.total);
                    expect(hiddenBody.media.length + visibleBody.media.length).toBe(allBody.media.length);
                    
                    // No overlap: hidden set and visible set are disjoint
                    const hiddenIds = new Set(hiddenBody.media.map((m: MediaRow) => m.media_id));
                    const visibleIds = new Set(visibleBody.media.map((m: MediaRow) => m.media_id));
                    
                    for (const id of hiddenIds) {
                        expect(visibleIds.has(id)).toBe(false);
                    }
                }),
                { numRuns: NUM_RUNS },
            );
        });
    });
});
