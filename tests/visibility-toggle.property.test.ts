// Property test for PATCH /api/admin/media/[media_id]/visibility — Task 3.2
//
// **Property 1: Visibility Toggle Inverts State**
// For any media item with a current visibility state, when an administrator
// toggles the visibility, the resulting state SHALL be the inverse of the
// original state (visible → hidden, or hidden → visible).
// **Validates: Requirements 1.2, 1.3**
//
// **Property 2: State Change Returns Success**
// For any media item visibility toggle operation that completes without error,
// the API response SHALL contain `success: true` and SHALL include the final
// `is_hidden` state.
// **Validates: Requirements 1.5, 6.2**
//
// This test uses fast-check to generate randomized visibility toggle sequences
// and verify that the endpoint correctly inverts state and returns consistent
// success responses. The database boundary is mocked to provide deterministic
// state tracking while testing the core inversion logic.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import jwt from 'jsonwebtoken';
import { NextRequest } from 'next/server';

// --- Mock database before importing route -----------------------------------
const { dbState, queryMock, connectMock, releaseMock, clientMock } = vi.hoisted(() => {
    const queryMock = vi.fn();
    const releaseMock = vi.fn();
    const clientMock = {
        query: queryMock,
        release: releaseMock,
    };
    const connectMock = vi.fn(() => Promise.resolve(clientMock));
    
    return { dbState: { currentState: false }, queryMock, connectMock, releaseMock, clientMock };
});

vi.mock('@/lib/db', () => ({
    default: { connect: connectMock },
}));

// Import route after mocks are set up
import { PATCH } from '@/app/api/admin/media/[media_id]/visibility/route';

// --- Test fixtures ----------------------------------------------------------
const TEST_SECRET = 'visibility-toggle-property-test-secret';
const ADMIN_USER_ID = 42;
const MEDIA_ID = 100;

function signToken(userId: number, isAdmin: boolean): string {
    return jwt.sign(
        { userId, email: isAdmin ? 'admin@test.com' : 'user@test.com', isAdmin },
        TEST_SECRET,
        { expiresIn: '1h' }
    );
}

function createRequest(mediaId: number, hidden: boolean, reason?: string): NextRequest {
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

// --- In-memory state model to track visibility state -----------------------
interface MediaStateModel {
    is_hidden: boolean;
    hidden_at: string | null;
    hidden_by: number | null;
    history: Array<{ action: 'hide' | 'unhide'; reason: string | null }>;
}

function createStateModel(initialState: boolean): MediaStateModel {
    return {
        is_hidden: initialState,
        hidden_at: initialState ? new Date().toISOString() : null,
        hidden_by: initialState ? ADMIN_USER_ID : null,
        history: [],
    };
}

function setupDatabaseMocks(state: MediaStateModel): void {
    queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
        // BEGIN transaction
        if (sql === 'BEGIN') {
            return { rows: [] };
        }
        
        // COMMIT transaction
        if (sql === 'COMMIT') {
            return { rows: [] };
        }
        
        // ROLLBACK transaction
        if (sql === 'ROLLBACK') {
            return { rows: [] };
        }
        
        // SELECT FOR UPDATE (locking)
        if (/SELECT media_id FROM media WHERE media_id = \$1 FOR UPDATE/i.test(sql)) {
            return { rows: [{ media_id: MEDIA_ID }] };
        }
        
        // UPDATE media visibility
        if (/UPDATE media/i.test(sql)) {
            const p = params ?? [];
            const newHidden = p[0] as boolean;
            const adminId = p[1] as number;
            
            // Update state model (this is the core: toggle inverts state)
            state.is_hidden = newHidden;
            state.hidden_at = newHidden ? new Date().toISOString() : null;
            state.hidden_by = newHidden ? adminId : null;
            
            return {
                rows: [{
                    media_id: MEDIA_ID,
                    is_hidden: state.is_hidden,
                    hidden_at: state.hidden_at,
                    hidden_by: state.hidden_by,
                }],
            };
        }
        
        // INSERT into moderation log
        if (/INSERT INTO media_moderation_log/i.test(sql)) {
            const p = params ?? [];
            const action = p[2] as 'hide' | 'unhide';
            const reason = p[3] as string | null;
            
            state.history.push({ action, reason });
            return { rows: [] };
        }
        
        throw new Error(`Unexpected query in visibility toggle property test: ${sql}`);
    });
}

// --- fast-check generators --------------------------------------------------

// Generate a sequence of toggle operations for a single media item
const toggleSequenceArb = fc.record({
    // Initial state of the media item (hidden or visible)
    initialState: fc.boolean(),
    // Number of toggle operations to perform (at least 1 to test inversion)
    numToggles: fc.integer({ min: 1, max: 5 }),
    // Optional reasons for each toggle (some with reasons, some without)
    reasons: fc.array(
        fc.oneof(
            fc.constant(undefined),
            fc.string({ minLength: 1, maxLength: 100 }),
        ),
        { minLength: 1, maxLength: 5 }
    ),
});

const originalSecret = process.env.JWT_SECRET;

beforeEach(() => {
    process.env.JWT_SECRET = TEST_SECRET;
    vi.clearAllMocks();
});

afterEach(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

const NUM_RUNS = 100;

describe('Visibility Toggle Properties', () => {
    describe('Property 1: Visibility Toggle Inverts State', () => {
        it('toggling visibility inverts the current state (visible → hidden, hidden → visible)', async () => {
            await fc.assert(
                fc.asyncProperty(toggleSequenceArb, async (scenario) => {
                    // Create fresh state model for this test run
                    const state = createStateModel(scenario.initialState);
                    setupDatabaseMocks(state);
                    
                    let expectedState = scenario.initialState;
                    
                    // Perform each toggle operation and verify state inversion
                    for (let i = 0; i < scenario.numToggles; i++) {
                        const targetState = !expectedState;
                        const reason = scenario.reasons[i % scenario.reasons.length];
                        
                        const request = createRequest(MEDIA_ID, targetState, reason);
                        const params = Promise.resolve({ media_id: String(MEDIA_ID) });
                        
                        const response = await PATCH(request, { params });
                        
                        // PROPERTY 1: State should be inverted
                        expect(state.is_hidden).toBe(targetState);
                        expect(state.is_hidden).toBe(!expectedState);
                        
                        // Verify response includes the new state
                        const body = await response.json();
                        expect(body.is_hidden).toBe(targetState);
                        
                        // Update expected state for next iteration
                        expectedState = targetState;
                    }
                    
                    // Final verification: if we toggled an odd number of times,
                    // state should differ from initial; even number means same as initial
                    if (scenario.numToggles % 2 === 0) {
                        expect(state.is_hidden).toBe(scenario.initialState);
                    } else {
                        expect(state.is_hidden).toBe(!scenario.initialState);
                    }
                }),
                { numRuns: NUM_RUNS }
            );
        });
    });

    describe('Property 2: State Change Returns Success', () => {
        it('successful visibility toggle returns success=true with final state', async () => {
            await fc.assert(
                fc.asyncProperty(
                    fc.boolean(), // initial state
                    fc.boolean(), // target state
                    fc.option(fc.string({ minLength: 1, maxLength: 500 }), { nil: undefined }), // optional reason
                    async (initialState, targetState, reason) => {
                        // Create fresh state model for this test run
                        const state = createStateModel(initialState);
                        setupDatabaseMocks(state);
                        
                        const request = createRequest(MEDIA_ID, targetState, reason);
                        const params = Promise.resolve({ media_id: String(MEDIA_ID) });
                        
                        const response = await PATCH(request, { params });
                        
                        // PROPERTY 2: Success response with correct structure
                        expect(response.status).toBe(200);
                        
                        const body = await response.json();
                        expect(body).toHaveProperty('success', true);
                        expect(body).toHaveProperty('media_id', MEDIA_ID);
                        expect(body).toHaveProperty('is_hidden', targetState);
                        expect(body).toHaveProperty('hidden_at');
                        expect(body).toHaveProperty('hidden_by');
                        
                        // Verify final state matches target
                        expect(body.is_hidden).toBe(targetState);
                        
                        // Verify state metadata consistency
                        if (targetState === true) {
                            // Hidden state should have timestamp and admin
                            expect(body.hidden_at).not.toBeNull();
                            expect(body.hidden_by).toBe(ADMIN_USER_ID);
                        } else {
                            // Visible state should clear timestamp and admin
                            expect(body.hidden_at).toBeNull();
                            expect(body.hidden_by).toBeNull();
                        }
                    }
                ),
                { numRuns: NUM_RUNS }
            );
        });
        
        it('audit log records every state change action', async () => {
            await fc.assert(
                fc.asyncProperty(toggleSequenceArb, async (scenario) => {
                    // Create fresh state model for this test run
                    const state = createStateModel(scenario.initialState);
                    setupDatabaseMocks(state);
                    
                    let currentState = scenario.initialState;
                    
                    // Perform each toggle operation
                    for (let i = 0; i < scenario.numToggles; i++) {
                        const targetState = !currentState;
                        const reason = scenario.reasons[i % scenario.reasons.length];
                        
                        const request = createRequest(MEDIA_ID, targetState, reason);
                        const params = Promise.resolve({ media_id: String(MEDIA_ID) });
                        
                        await PATCH(request, { params });
                        currentState = targetState;
                    }
                    
                    // PROPERTY 2 (audit trail): Every toggle created a log entry
                    expect(state.history).toHaveLength(scenario.numToggles);
                    
                    // Verify each log entry has correct action type
                    let expectedState = scenario.initialState;
                    for (let i = 0; i < scenario.numToggles; i++) {
                        const expectedAction = !expectedState ? 'hide' : 'unhide';
                        expect(state.history[i].action).toBe(expectedAction);
                        expectedState = !expectedState;
                    }
                }),
                { numRuns: NUM_RUNS }
            );
        });
    });

    describe('Property Combinations: State Inversion + Success Response', () => {
        it('every successful toggle both inverts state AND returns success', async () => {
            await fc.assert(
                fc.asyncProperty(
                    fc.boolean(), // initial state
                    fc.integer({ min: 1, max: 10 }), // number of toggles
                    async (initialState, numToggles) => {
                        // Create fresh state model for this test run
                        const state = createStateModel(initialState);
                        setupDatabaseMocks(state);
                        
                        const responses: Response[] = [];
                        let expectedState = initialState;
                        
                        // Perform toggle sequence
                        for (let i = 0; i < numToggles; i++) {
                            const targetState = !expectedState;
                            
                            const request = createRequest(MEDIA_ID, targetState);
                            const params = Promise.resolve({ media_id: String(MEDIA_ID) });
                            
                            const response = await PATCH(request, { params });
                            responses.push(response);
                            
                            expectedState = targetState;
                        }
                        
                        // COMBINED PROPERTIES: All responses successful + state correctly toggled
                        for (let i = 0; i < responses.length; i++) {
                            expect(responses[i].status).toBe(200);
                            
                            const body = await responses[i].clone().json();
                            expect(body.success).toBe(true);
                            expect(body).toHaveProperty('is_hidden');
                            expect(body).toHaveProperty('media_id', MEDIA_ID);
                        }
                        
                        // Final state matches parity expectation
                        if (numToggles % 2 === 0) {
                            expect(state.is_hidden).toBe(initialState);
                        } else {
                            expect(state.is_hidden).toBe(!initialState);
                        }
                    }
                ),
                { numRuns: NUM_RUNS }
            );
        });
    });
});
