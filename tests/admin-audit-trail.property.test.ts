// Property tests for audit trail — Task 3.6
//
// **Property 8: Audit Trail Creation**
// For any media visibility state change, the system SHALL create a moderation
// log entry containing the admin's user ID, the current timestamp (within 1
// second of the request), and the action type (hide or unhide).
// **Validates: Requirements 4.1, 4.2**
//
// **Property 9: Reason Persistence**
// For any hide action where a moderation reason is provided, the system SHALL
// store that reason in the moderation log entry and SHALL retrieve it when
// querying the moderation history.
// **Validates: Requirements 5.2**
//
// **Property 10: Reason Length Validation**
// For any moderation reason string with length ≤ 500 characters, the system
// SHALL accept it. For any reason string with length > 500 characters, the
// system SHALL reject the request with a 400 Bad Request response.
// **Validates: Requirements 5.4**
//
// This is a UNIT-level property test against the real route handlers.
// External boundaries mocked:
//   - `@/lib/db` -> pool.connect() for the visibility route (transactional)
//                   pool.query() for the history route (direct)
// REAL: `@/lib/auth` verifyRequest with actual signed JWT.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import jwt from 'jsonwebtoken';
import { NextRequest } from 'next/server';

// --- Mock database before importing routes ----------------------------------
// The visibility PATCH route uses pool.connect() (transaction client),
// while the history GET route uses pool.query() directly.
// We hoist mutable state for both shapes.

const {
    auditLog,
    clientQueryMock,
    clientReleaseMock,
    clientMock,
    connectMock,
    historyQueryMock,
} = vi.hoisted(() => {
    // Shared in-memory audit log — written by PATCH mock, read by GET mock
    const auditLog: Array<{
        media_id: number;
        admin_id: number;
        action: 'hide' | 'unhide';
        reason: string | null;
        log_id: number;
        created_at: Date;
        admin_username: string;
    }> = [];

    const clientReleaseMock = vi.fn();
    const clientQueryMock = vi.fn();
    const clientMock = {
        query: clientQueryMock,
        release: clientReleaseMock,
    };
    const connectMock = vi.fn(() => Promise.resolve(clientMock));

    // History route uses pool.query (non-transactional)
    const historyQueryMock = vi.fn();

    return {
        auditLog,
        clientQueryMock,
        clientReleaseMock,
        clientMock,
        connectMock,
        historyQueryMock,
    };
});

vi.mock('@/lib/db', () => ({
    default: {
        connect: connectMock,
        query: historyQueryMock,
    },
}));

// Import routes AFTER mocks are registered
import { PATCH } from '@/app/api/admin/media/[media_id]/visibility/route';
import { GET as GET_HISTORY } from '@/app/api/admin/media/[media_id]/history/route';

// --- Test fixtures ----------------------------------------------------------
const TEST_SECRET = 'admin-audit-trail-property-test-secret';
const ADMIN_USER_ID = 42;
const ADMIN_USERNAME = 'test_admin';
const MEDIA_ID = 100;

function signToken(userId: number, isAdmin: boolean): string {
    return jwt.sign(
        { userId, email: isAdmin ? 'admin@example.com' : 'user@example.com', isAdmin },
        TEST_SECRET,
        { expiresIn: '1h' }
    );
}

function createPatchRequest(mediaId: number, hidden: boolean, reason?: string): NextRequest {
    const url = `http://localhost/api/admin/media/${mediaId}/visibility`;
    const body: { hidden: boolean; reason?: string } = { hidden };
    if (reason !== undefined) {
        body.reason = reason;
    }
    const token = signToken(ADMIN_USER_ID, true);
    return new NextRequest(url, {
        method: 'PATCH',
        headers: {
            'Content-Type': 'application/json',
            Cookie: `auth_token=${token}`,
        },
        body: JSON.stringify(body),
    });
}

function createHistoryRequest(mediaId: number): NextRequest {
    const url = `http://localhost/api/admin/media/${mediaId}/history`;
    const token = signToken(ADMIN_USER_ID, true);
    return new NextRequest(url, {
        method: 'GET',
        headers: { Cookie: `auth_token=${token}` },
    });
}

// --- In-memory media state model -------------------------------------------
interface MediaState {
    is_hidden: boolean;
    hidden_at: string | null;
    hidden_by: number | null;
}

// Wire up the transaction client mock to a mutable media state model.
// Each test run resets both the state model and the shared audit log.
function setupVisibilityMocks(mediaState: MediaState): void {
    clientQueryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
            return { rows: [] };
        }

        // SELECT FOR UPDATE — media exists
        if (/SELECT media_id FROM media WHERE media_id = \$1 FOR UPDATE/i.test(sql)) {
            return { rows: [{ media_id: MEDIA_ID }] };
        }

        // UPDATE media visibility
        if (/UPDATE media/i.test(sql)) {
            const p = params ?? [];
            const newHidden = p[0] as boolean;
            const adminId = p[1] as number;

            mediaState.is_hidden = newHidden;
            mediaState.hidden_at = newHidden ? new Date().toISOString() : null;
            mediaState.hidden_by = newHidden ? adminId : null;

            return {
                rows: [{
                    media_id: MEDIA_ID,
                    is_hidden: mediaState.is_hidden,
                    hidden_at: mediaState.hidden_at,
                    hidden_by: mediaState.hidden_by,
                }],
            };
        }

        // INSERT into moderation log — capture into shared auditLog
        if (/INSERT INTO media_moderation_log/i.test(sql)) {
            const p = params ?? [];
            const logEntry = {
                media_id: p[0] as number,
                admin_id: p[1] as number,
                action: p[2] as 'hide' | 'unhide',
                reason: (p[3] ?? null) as string | null,
                log_id: auditLog.length + 1,
                created_at: new Date(),
                admin_username: ADMIN_USERNAME,
            };
            auditLog.push(logEntry);
            return { rows: [] };
        }

        throw new Error(`[audit-trail tests] Unexpected visibility query: ${sql}`);
    });
}

// Wire up the history GET route mock to serve from the shared audit log.
function setupHistoryMocks(mediaId: number): void {
    historyQueryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
        // Media existence check
        if (/SELECT media_id FROM media WHERE media_id = \$1$/.test(sql.trim())) {
            return { rows: [{ media_id: mediaId }] };
        }

        // Moderation history query — return matching entries from auditLog
        if (/FROM media_moderation_log ml/i.test(sql)) {
            const mid = (params ?? [])[0] as number;
            const entries = auditLog
                .filter(e => e.media_id === mid)
                .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());

            return { rows: entries };
        }

        throw new Error(`[audit-trail tests] Unexpected history query: ${sql}`);
    });
}

// --- Generators ------------------------------------------------------------

// Arbitrary reason string with 1..500 characters (valid)
const validReasonArb = fc.string({ minLength: 1, maxLength: 500 });

// Arbitrary reason string with exactly 500 characters (boundary valid)
const exactlyFiveHundredReasonArb = fc
    .string({ minLength: 1, maxLength: 500 })
    .map(s => s.padEnd(500, 'x').slice(0, 500));

// Arbitrary reason string exceeding 500 characters (invalid)
const tooLongReasonArb = fc
    .string({ minLength: 1, maxLength: 500 })
    .map(s => s.padEnd(501, 'x').slice(0, 501) + fc.sample(fc.string({ minLength: 0, maxLength: 200 }), 1)[0])
    .filter(s => s.length > 500);

// Simplified: just generate strings of length 501..700
const overLimitReasonArb = fc.string({ minLength: 501, maxLength: 700 });

// Toggle action: hidden=true ('hide') or hidden=false ('unhide')
const toggleActionArb = fc.boolean(); // true = hide, false = unhide

const originalSecret = process.env.JWT_SECRET;

beforeEach(() => {
    process.env.JWT_SECRET = TEST_SECRET;
    vi.clearAllMocks();
    // Reset shared audit log before each test
    auditLog.length = 0;
});

afterEach(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

const NUM_RUNS = 100;

// ---------------------------------------------------------------------------
// Property 8: Audit Trail Creation
// ---------------------------------------------------------------------------
describe('Property 8: Audit Trail Creation', () => {
    it(
        'every visibility state change produces a log entry with correct admin_id, action, and timestamp within 1s',
        async () => {
            await fc.assert(
                fc.asyncProperty(
                    toggleActionArb,
                    fc.boolean(), // initial media state
                    async (targetHidden, initialHidden) => {
                        // Per-run isolation: reset log and set up fresh state
                        auditLog.length = 0;
                        const mediaState: MediaState = {
                            is_hidden: initialHidden,
                            hidden_at: initialHidden ? new Date().toISOString() : null,
                            hidden_by: initialHidden ? ADMIN_USER_ID : null,
                        };
                        setupVisibilityMocks(mediaState);

                        const before = Date.now();

                        const request = createPatchRequest(MEDIA_ID, targetHidden);
                        const params = Promise.resolve({ media_id: String(MEDIA_ID) });

                        const response = await PATCH(request, { params });

                        const after = Date.now();

                        // Request must succeed
                        expect(response.status).toBe(200);

                        // P8: exactly one log entry was created
                        expect(auditLog).toHaveLength(1);

                        const entry = auditLog[0];

                        // P8: admin_id matches the authenticated admin (Requirement 4.1)
                        expect(entry.admin_id).toBe(ADMIN_USER_ID);

                        // P8: action matches the target state (Requirement 4.2)
                        const expectedAction = targetHidden ? 'hide' : 'unhide';
                        expect(entry.action).toBe(expectedAction);

                        // P8: media_id is recorded correctly
                        expect(entry.media_id).toBe(MEDIA_ID);

                        // P8: timestamp is within 1 second of the request window (Requirement 4.2)
                        const entryTime = entry.created_at.getTime();
                        expect(entryTime).toBeGreaterThanOrEqual(before - 1000);
                        expect(entryTime).toBeLessThanOrEqual(after + 1000);
                    }
                ),
                { numRuns: NUM_RUNS }
            );
        }
    );

    it(
        'N visibility toggles produce exactly N log entries, each with matching action type',
        async () => {
            await fc.assert(
                fc.asyncProperty(
                    fc.integer({ min: 1, max: 8 }), // number of toggles
                    fc.boolean(),                     // initial state
                    async (numToggles, initialHidden) => {
                        auditLog.length = 0;
                        const mediaState: MediaState = {
                            is_hidden: initialHidden,
                            hidden_at: initialHidden ? new Date().toISOString() : null,
                            hidden_by: initialHidden ? ADMIN_USER_ID : null,
                        };
                        setupVisibilityMocks(mediaState);

                        let currentState = initialHidden;

                        for (let i = 0; i < numToggles; i++) {
                            const target = !currentState;
                            const request = createPatchRequest(MEDIA_ID, target);
                            const params = Promise.resolve({ media_id: String(MEDIA_ID) });
                            await PATCH(request, { params });
                            currentState = target;
                        }

                        // P8: one log entry per toggle
                        expect(auditLog).toHaveLength(numToggles);

                        // Each entry has correct action type
                        let state = initialHidden;
                        for (let i = 0; i < numToggles; i++) {
                            const expectedAction: 'hide' | 'unhide' = !state ? 'hide' : 'unhide';
                            expect(auditLog[i].action).toBe(expectedAction);
                            expect(auditLog[i].admin_id).toBe(ADMIN_USER_ID);
                            state = !state;
                        }
                    }
                ),
                { numRuns: NUM_RUNS }
            );
        }
    );
});

// ---------------------------------------------------------------------------
// Property 9: Reason Persistence
// ---------------------------------------------------------------------------
describe('Property 9: Reason Persistence', () => {
    it(
        'any reason provided during hide is stored in the log and returned by the history endpoint',
        async () => {
            await fc.assert(
                fc.asyncProperty(
                    validReasonArb,
                    async (reason) => {
                        auditLog.length = 0;
                        const mediaState: MediaState = {
                            is_hidden: false, // start visible so we are hiding
                            hidden_at: null,
                            hidden_by: null,
                        };
                        setupVisibilityMocks(mediaState);
                        setupHistoryMocks(MEDIA_ID);

                        // PATCH: hide with reason
                        const patchRequest = createPatchRequest(MEDIA_ID, true, reason);
                        const params = Promise.resolve({ media_id: String(MEDIA_ID) });
                        const patchResp = await PATCH(patchRequest, { params });

                        expect(patchResp.status).toBe(200);

                        // P9: reason stored in audit log (Requirement 5.2)
                        expect(auditLog).toHaveLength(1);
                        expect(auditLog[0].reason).toBe(reason);

                        // GET history: reason is returned
                        const historyRequest = createHistoryRequest(MEDIA_ID);
                        const historyParams = Promise.resolve({ media_id: String(MEDIA_ID) });
                        const historyResp = await GET_HISTORY(historyRequest, { params: historyParams });

                        expect(historyResp.status).toBe(200);
                        const historyBody = await historyResp.json();

                        expect(historyBody.history).toHaveLength(1);
                        // P9: the exact same reason is returned (Requirement 5.2)
                        expect(historyBody.history[0].reason).toBe(reason);
                    }
                ),
                { numRuns: NUM_RUNS }
            );
        }
    );

    it(
        'when no reason is provided, the log entry stores null reason',
        async () => {
            await fc.assert(
                fc.asyncProperty(
                    toggleActionArb,
                    async (targetHidden) => {
                        auditLog.length = 0;
                        const mediaState: MediaState = {
                            is_hidden: !targetHidden,
                            hidden_at: null,
                            hidden_by: null,
                        };
                        setupVisibilityMocks(mediaState);
                        setupHistoryMocks(MEDIA_ID);

                        // PATCH without reason
                        const request = createPatchRequest(MEDIA_ID, targetHidden);
                        const params = Promise.resolve({ media_id: String(MEDIA_ID) });
                        const response = await PATCH(request, { params });

                        expect(response.status).toBe(200);

                        expect(auditLog).toHaveLength(1);
                        expect(auditLog[0].reason).toBeNull();

                        // GET history: reason is null
                        const historyRequest = createHistoryRequest(MEDIA_ID);
                        const historyParams = Promise.resolve({ media_id: String(MEDIA_ID) });
                        const historyResp = await GET_HISTORY(historyRequest, { params: historyParams });

                        const historyBody = await historyResp.json();
                        expect(historyBody.history[0].reason).toBeNull();
                    }
                ),
                { numRuns: NUM_RUNS }
            );
        }
    );

    it(
        'multiple hide actions with distinct reasons each persist their own reason',
        async () => {
            await fc.assert(
                fc.asyncProperty(
                    fc.array(validReasonArb, { minLength: 2, maxLength: 5 }),
                    async (reasons) => {
                        auditLog.length = 0;
                        const mediaState: MediaState = {
                            is_hidden: false,
                            hidden_at: null,
                            hidden_by: null,
                        };
                        setupVisibilityMocks(mediaState);
                        setupHistoryMocks(MEDIA_ID);

                        // Alternate hide/unhide, providing reasons on hide actions
                        let currentState = false;
                        const expectedReasons: (string | null)[] = [];

                        for (const reason of reasons) {
                            const target = !currentState;
                            // Only provide reason when hiding
                            const r = target ? reason : undefined;
                            const request = createPatchRequest(MEDIA_ID, target, r);
                            const params = Promise.resolve({ media_id: String(MEDIA_ID) });
                            await PATCH(request, { params });
                            expectedReasons.push(target ? reason : null);
                            currentState = target;
                        }

                        // P9: each log entry has its reason preserved in order
                        expect(auditLog).toHaveLength(reasons.length);
                        for (let i = 0; i < reasons.length; i++) {
                            expect(auditLog[i].reason).toBe(expectedReasons[i]);
                        }
                    }
                ),
                { numRuns: NUM_RUNS }
            );
        }
    );
});

// ---------------------------------------------------------------------------
// Property 10: Reason Length Validation
// ---------------------------------------------------------------------------
describe('Property 10: Reason Length Validation', () => {
    it(
        'reasons with length ≤ 500 are accepted (returns 200)',
        async () => {
            await fc.assert(
                fc.asyncProperty(
                    fc.string({ minLength: 0, maxLength: 500 }),
                    async (reason) => {
                        auditLog.length = 0;
                        const mediaState: MediaState = {
                            is_hidden: false,
                            hidden_at: null,
                            hidden_by: null,
                        };
                        setupVisibilityMocks(mediaState);

                        // Pass reason only when it's a non-empty string (empty means no reason)
                        const request = reason.length > 0
                            ? createPatchRequest(MEDIA_ID, true, reason)
                            : createPatchRequest(MEDIA_ID, true);

                        const params = Promise.resolve({ media_id: String(MEDIA_ID) });
                        const response = await PATCH(request, { params });

                        // P10: must be accepted (Requirement 5.4)
                        expect(response.status).toBe(200);
                    }
                ),
                { numRuns: NUM_RUNS }
            );
        }
    );

    it(
        'a reason of exactly 500 characters is accepted (boundary)',
        async () => {
            await fc.assert(
                fc.asyncProperty(
                    exactlyFiveHundredReasonArb,
                    async (reason) => {
                        // Verify the generator constraint
                        expect(reason.length).toBe(500);

                        auditLog.length = 0;
                        const mediaState: MediaState = {
                            is_hidden: false,
                            hidden_at: null,
                            hidden_by: null,
                        };
                        setupVisibilityMocks(mediaState);

                        const request = createPatchRequest(MEDIA_ID, true, reason);
                        const params = Promise.resolve({ media_id: String(MEDIA_ID) });
                        const response = await PATCH(request, { params });

                        // P10 boundary: exactly 500 chars must be accepted
                        expect(response.status).toBe(200);
                    }
                ),
                { numRuns: NUM_RUNS }
            );
        }
    );

    it(
        'reasons with length > 500 are rejected with 400',
        async () => {
            await fc.assert(
                fc.asyncProperty(
                    overLimitReasonArb,
                    async (reason) => {
                        // Verify generator constraint
                        expect(reason.length).toBeGreaterThan(500);

                        auditLog.length = 0;
                        const mediaState: MediaState = {
                            is_hidden: false,
                            hidden_at: null,
                            hidden_by: null,
                        };
                        setupVisibilityMocks(mediaState);

                        const request = createPatchRequest(MEDIA_ID, true, reason);
                        const params = Promise.resolve({ media_id: String(MEDIA_ID) });
                        const response = await PATCH(request, { params });

                        // P10: must be rejected (Requirement 5.4)
                        expect(response.status).toBe(400);

                        const body = await response.json();
                        expect(body.error).toMatch(/500/);

                        // No audit log entry should have been created for rejected requests
                        expect(auditLog).toHaveLength(0);
                    }
                ),
                { numRuns: NUM_RUNS }
            );
        }
    );

    it(
        'length boundary: 500 accepts, 501 rejects',
        async () => {
            await fc.assert(
                fc.asyncProperty(
                    // Generate a base string of exactly 500 chars
                    fc.string({ minLength: 1, maxLength: 500 }).map(s => s.padEnd(500, 'a').slice(0, 500)),
                    async (baseReason) => {
                        expect(baseReason.length).toBe(500);

                        // --- Test: 500 chars accepts ---
                        auditLog.length = 0;
                        const mediaState500: MediaState = { is_hidden: false, hidden_at: null, hidden_by: null };
                        setupVisibilityMocks(mediaState500);

                        const req500 = createPatchRequest(MEDIA_ID, true, baseReason);
                        const params = Promise.resolve({ media_id: String(MEDIA_ID) });
                        const resp500 = await PATCH(req500, { params });
                        expect(resp500.status).toBe(200);

                        // --- Test: 501 chars rejects ---
                        auditLog.length = 0;
                        const mediaState501: MediaState = { is_hidden: false, hidden_at: null, hidden_by: null };
                        setupVisibilityMocks(mediaState501);

                        const overReason = baseReason + 'X'; // exactly 501
                        expect(overReason.length).toBe(501);

                        const req501 = createPatchRequest(MEDIA_ID, true, overReason);
                        const resp501 = await PATCH(req501, { params });
                        expect(resp501.status).toBe(400);

                        // No log entry for rejected request
                        expect(auditLog).toHaveLength(0);
                    }
                ),
                { numRuns: NUM_RUNS }
            );
        }
    );
});
