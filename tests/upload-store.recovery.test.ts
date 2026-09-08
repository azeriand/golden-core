// Store-level tests for cross-reload recovery + transparent auto-resume
//
// Runs in the default `node` environment (no jsdom dependency). The upload
// store touches only a handful of browser globals on the recovery path, all of
// which are stubbed below: `window.location` (getEventSlug — unused here since
// recoverInterrupted takes the slug as an arg), `URL.createObjectURL/revoke`
// (auto-resume preview), `fetch` (confirm), `indexedDB` (fake-indexeddb), plus
// `crypto.randomUUID`/`File`/`Blob` which Node 20 provides natively.
//
// Original header:
// (Change 3, upload.store.ts `recoverInterrupted` / `retryConfirm`).
//
// These exercise the REAL upload store against a REAL fake-indexeddb queue
// (lib/upload-queue.ts, unmocked) so byte persistence + cleanup are verified
// end-to-end. The only mocked boundaries are:
//   - `@/lib/blob-upload-client` `uploadToBlob` -> a controllable fake so the
//     auto-resume path can be driven without a network Blob upload; it lets us
//     assert the SAME uploadId is reused (P1: no duplicate rows) and that a
//     resumed image drives the normal attempt-guarded machinery.
//   - global `fetch` -> the confirm endpoint, returning a Media-DTO-shaped body
//     (Change 1) or an error to drive success/failure branches.
//   - axios (used by auth/event stores) is not hit on the recovery path.
//
// The module-level run-once recovery guard means each test must re-import the
// store fresh (vi.resetModules) with a fresh fake IndexedDB factory, mirroring
// the upload-queue test approach.

import {
    describe,
    it,
    expect,
    beforeEach,
    afterEach,
    vi,
} from 'vitest';

// --- Hoisted mock holders ----------------------------------------------------
const { uploadToBlobMock } = vi.hoisted(() => ({
    uploadToBlobMock: vi.fn(),
}));

vi.mock('@/lib/blob-upload-client', () => ({
    uploadToBlob: (...args: unknown[]) => uploadToBlobMock(...args),
}));

// axios is imported by event/auth stores; stub it so nothing hits the network
// if a code path touches it. Recovery itself uses `fetch`, not axios.
vi.mock('axios', () => ({
    default: {
        get: vi.fn(async () => ({ data: {} })),
        post: vi.fn(async () => ({ data: {} })),
    },
}));

const EVENT_SLUG = 'my-event';
const EVENT_ID = 12;
const SECTION_ID = 99;
const BLOB_HOST = 'https://blob.example.com';

type StoreModule = typeof import('@/app/src/stores/upload.store');
type QueueModule = typeof import('@/lib/upload-queue');
type EventModule = typeof import('@/app/src/stores/event.store');

interface Loaded {
    useUploadStore: StoreModule['default'];
    uploadQueue: QueueModule['uploadQueue'];
    useEventStore: EventModule['default'];
}

/** Fresh module graph + fresh fake IndexedDB per test (run-once guard reset). */
async function loadFresh(): Promise<Loaded> {
    vi.resetModules();
    const { IDBFactory } = await import('fake-indexeddb');
    vi.stubGlobal('indexedDB', new IDBFactory());

    const queueMod = (await import('@/lib/upload-queue')) as QueueModule;
    const eventMod = (await import('@/app/src/stores/event.store')) as EventModule;
    const storeMod = (await import('@/app/src/stores/upload.store')) as StoreModule;

    // Seed a resolved event so processOne can read event_id and append media.
    eventMod.default.setState({
        event: {
            event_id: EVENT_ID,
            event_name: 'Test',
            event_slug: EVENT_SLUG,
            event_date: '2024-01-01',
            sections: [
                {
                    section_id: SECTION_ID,
                    section_name: 'Sin clasificar',
                    start_date: '',
                    finish_date: '',
                    media: [],
                },
            ],
        } as never,
        loading: false,
    });

    return {
        useUploadStore: storeMod.default,
        uploadQueue: queueMod.uploadQueue,
        useEventStore: eventMod.default,
    };
}

function makeRecord(
    over: Partial<import('@/lib/upload-queue').QueueRecord>,
): import('@/lib/upload-queue').QueueRecord {
    return {
        uploadId: '11111111-1111-4111-8111-111111111111',
        eventSlug: EVENT_SLUG,
        filename: 'photo.jpg',
        contentType: 'image/jpeg',
        originalSize: 1_000_000,
        processedSize: 400_000,
        status: 'uploading',
        blobUrl: null,
        error: null,
        date: '2024-01-15T10:30:00.000Z',
        updatedAt: Date.now(),
        ...over,
    };
}

/** A Media-DTO-shaped confirm response body (Change 1). */
function mediaDto(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        media_id: 501,
        user_id: 5,
        content: `${BLOB_HOST}/events/${EVENT_ID}/x/photo.jpg`,
        type: 'image/jpeg',
        likes: 0,
        liked: false,
        date: '2024-01-15T10:30:00.000Z',
        section_id: SECTION_ID,
        blurhash: 'LEHV6nWB2yk8',
        username: 'tester',
        ...over,
    };
}

/** Install a fetch stub that answers the confirm endpoint. */
function stubConfirmFetch(
    responder: (url: string, body: Record<string, unknown>) => {
        ok: boolean;
        status: number;
        json: unknown;
    },
): void {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
            const body = init?.body ? JSON.parse(init.body as string) : {};
            const r = responder(String(url), body);
            return {
                ok: r.ok,
                status: r.status,
                json: async () => r.json,
            } as Response;
        }),
    );
}

/** Wait for pending microtasks/macrotasks so async recovery settles. */
async function flush(times = 6): Promise<void> {
    for (let i = 0; i < times; i++) {
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
    }
}

beforeEach(() => {
    // Minimal `window` so getEventSlug (if reached) resolves to our slug.
    vi.stubGlobal('window', {
        location: { pathname: `/${EVENT_SLUG}` },
    });
    // Node's URL lacks createObjectURL/revokeObjectURL; add them (preserving the
    // native URL class + parsing) so the auto-resume preview object URL creation
    // is a harmless no-op and any `new URL(...)` elsewhere still works.
    let urlCounter = 0;
    (URL as unknown as { createObjectURL?: (b: Blob) => string }).createObjectURL =
        () => `blob:mock-${urlCounter++}`;
    (URL as unknown as { revokeObjectURL?: (u: string) => void }).revokeObjectURL =
        () => {};
    // Ensure crypto.randomUUID exists.
    if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.randomUUID) {
        vi.stubGlobal('crypto', {
            randomUUID: () => '99999999-9999-4999-8999-999999999999',
        });
    }
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.resetModules();
});

describe('recoverInterrupted — completed record', () => {
    it('removes a completed record + its bytes and surfaces nothing', async () => {
        const { useUploadStore, uploadQueue } = await loadFresh();
        const rec = makeRecord({ uploadId: 'done-1', status: 'completed' });
        await uploadQueue.put(rec);
        await uploadQueue.putBytes('done-1', new Blob([new Uint8Array(8)]));

        await useUploadStore.getState().recoverInterrupted(EVENT_SLUG);
        await flush();

        expect(useUploadStore.getState().items).toHaveLength(0);
        expect(await uploadQueue.all()).toHaveLength(0);
        expect(await uploadQueue.getBytes('done-1')).toBeNull();
    });
});

describe('recoverInterrupted — has blobUrl (auto-confirm)', () => {
    it('auto-confirms silently on success: appends Media, removes record+bytes, no item', async () => {
        const { useUploadStore, uploadQueue, useEventStore } = await loadFresh();
        const rec = makeRecord({
            uploadId: 'blob-ok',
            blobUrl: `${BLOB_HOST}/events/${EVENT_ID}/blob-ok/photo.jpg`,
            status: 'uploading',
        });
        await uploadQueue.put(rec);

        let confirmedBody: Record<string, unknown> | null = null;
        stubConfirmFetch((_url, body) => {
            confirmedBody = body;
            return { ok: true, status: 201, json: mediaDto({ media_id: 777 }) };
        });

        await useUploadStore.getState().recoverInterrupted(EVENT_SLUG);
        await flush();

        // No surfaced item; Media appended to the event store.
        expect(useUploadStore.getState().items).toHaveLength(0);
        const media = useEventStore.getState().event!.sections[0].media;
        expect(media.some((m) => m.media_id === 777)).toBe(true);
        // Record removed after success.
        expect(await uploadQueue.all()).toHaveLength(0);
        // Confirm reused the SAME uploadId (P1: dedupe).
        expect(confirmedBody).not.toBeNull();
        const body = confirmedBody as unknown as Record<string, unknown>;
        expect(body.uploadId).toBe('blob-ok');
        // Persisted enqueue-time date was used (Req 14.10), not fabricated.
        expect(body.date).toBe('2024-01-15T10:30:00.000Z');
    });

    it('on auto-confirm failure surfaces a confirm-retry item (kept, not dropped)', async () => {
        const { useUploadStore, uploadQueue } = await loadFresh();
        const rec = makeRecord({
            uploadId: 'blob-fail',
            blobUrl: `${BLOB_HOST}/events/${EVENT_ID}/blob-fail/photo.jpg`,
        });
        await uploadQueue.put(rec);

        stubConfirmFetch(() => ({ ok: false, status: 500, json: {} }));

        await useUploadStore.getState().recoverInterrupted(EVENT_SLUG);
        await flush();

        const items = useUploadStore.getState().items;
        expect(items).toHaveLength(1);
        expect(items[0].id).toBe('blob-fail');
        expect(items[0].recovery).toBe('confirm-retry');
        // Record KEPT so it remains retryable (no silent drop).
        expect(await uploadQueue.all()).toHaveLength(1);
    });
});

describe('recoverInterrupted — transparent auto-resume (image with bytes)', () => {
    it('auto-resumes the SAME uploadId through uploadToBlob + confirm, no duplicate', async () => {
        const { useUploadStore, uploadQueue, useEventStore } = await loadFresh();
        const rec = makeRecord({
            uploadId: 'resume-1',
            blobUrl: null,
            status: 'uploading',
            kind: 'image',
            hasBytes: true,
        });
        await uploadQueue.put(rec);
        await uploadQueue.putBytes(
            'resume-1',
            new Blob([new Uint8Array(1000)], { type: 'image/jpeg' }),
        );

        // uploadToBlob resolves as if the direct-to-Blob upload succeeded.
        uploadToBlobMock.mockImplementation(
            async (args: { uploadId: string }) => ({
                uploadId: args.uploadId,
                blobUrl: `${BLOB_HOST}/events/${EVENT_ID}/${args.uploadId}/photo.jpg`,
                pathname: `events/${EVENT_ID}/${args.uploadId}/photo.jpg`,
                filename: 'photo.jpg',
                contentType: 'image/jpeg',
                originalSize: 1000,
                processedSize: 800,
                processed: true,
                blurhash: 'LEHV6nWB2yk8',
            }),
        );

        const confirmedUploadIds: string[] = [];
        stubConfirmFetch((_url, body) => {
            confirmedUploadIds.push(body.uploadId as string);
            return { ok: true, status: 201, json: mediaDto({ media_id: 888 }) };
        });

        await useUploadStore.getState().recoverInterrupted(EVENT_SLUG);
        await flush(10);

        // uploadToBlob was invoked with the SAME uploadId (never a new one).
        expect(uploadToBlobMock).toHaveBeenCalledTimes(1);
        expect(uploadToBlobMock.mock.calls[0][0].uploadId).toBe('resume-1');
        // Confirm ran exactly once, with the same uploadId (no duplicate rows).
        expect(confirmedUploadIds).toEqual(['resume-1']);
        // Media appended and item completed.
        const media = useEventStore.getState().event!.sections[0].media;
        expect(media.some((m) => m.media_id === 888)).toBe(true);
        // Cleanup: record + bytes removed after confirm success.
        expect(await uploadQueue.all()).toHaveLength(0);
        expect(await uploadQueue.getBytes('resume-1')).toBeNull();
    });
});

describe('recoverInterrupted — no bytes (video / oversized image)', () => {
    it('surfaces a video with its persisted thumbnail as an inert dismissable item', async () => {
        const { useUploadStore, uploadQueue } = await loadFresh();
        const rec = makeRecord({
            uploadId: 'vid-1',
            filename: 'clip.mp4',
            contentType: 'video/mp4',
            blobUrl: null,
            kind: 'video',
            hasBytes: false,
            thumbnailDataUrl: 'data:image/jpeg;base64,AAAA',
        });
        await uploadQueue.put(rec);

        // uploadToBlob must NEVER be called for a no-bytes surface.
        await useUploadStore.getState().recoverInterrupted(EVENT_SLUG);
        await flush();

        expect(uploadToBlobMock).not.toHaveBeenCalled();
        const items = useUploadStore.getState().items;
        expect(items).toHaveLength(1);
        expect(items[0].id).toBe('vid-1');
        expect(items[0].recovery).toBe('inert');
        expect(items[0].thumbnailDataUrl).toBe('data:image/jpeg;base64,AAAA');
        // Record KEPT (surfaced, not dropped) until the user dismisses it.
        expect(await uploadQueue.all()).toHaveLength(1);
    });

    it('surfaces an oversized image (no bytes) as an inert item with its thumbnail', async () => {
        const { useUploadStore, uploadQueue } = await loadFresh();
        const rec = makeRecord({
            uploadId: 'big-1',
            filename: 'huge.jpg',
            contentType: 'image/jpeg',
            originalSize: 40 * 1024 * 1024,
            blobUrl: null,
            kind: 'image',
            oversized: true,
            hasBytes: false,
            thumbnailDataUrl: 'data:image/jpeg;base64,BBBB',
        });
        await uploadQueue.put(rec);

        await useUploadStore.getState().recoverInterrupted(EVENT_SLUG);
        await flush();

        expect(uploadToBlobMock).not.toHaveBeenCalled();
        const items = useUploadStore.getState().items;
        expect(items).toHaveLength(1);
        expect(items[0].recovery).toBe('inert');
        expect(items[0].thumbnailDataUrl).toBe('data:image/jpeg;base64,BBBB');
    });
});

describe('recoverInterrupted — recovery notice (video/oversized cannot auto-resume)', () => {
    it('raises recoveryNotice when a video is surfaced as inert', async () => {
        const { useUploadStore, uploadQueue } = await loadFresh();
        await uploadQueue.put(
            makeRecord({
                uploadId: 'vid-notice',
                filename: 'clip.mp4',
                contentType: 'video/mp4',
                blobUrl: null,
                kind: 'video',
                hasBytes: false,
                thumbnailDataUrl: 'data:image/jpeg;base64,AAAA',
            }),
        );

        expect(useUploadStore.getState().recoveryNotice).toBe(false);
        await useUploadStore.getState().recoverInterrupted(EVENT_SLUG);
        await flush();

        expect(useUploadStore.getState().recoveryNotice).toBe(true);

        // Dismiss clears it.
        useUploadStore.getState().dismissRecoveryNotice();
        expect(useUploadStore.getState().recoveryNotice).toBe(false);
    });

    it('raises recoveryNotice for an oversized image surfaced as inert', async () => {
        const { useUploadStore, uploadQueue } = await loadFresh();
        await uploadQueue.put(
            makeRecord({
                uploadId: 'big-notice',
                filename: 'huge.jpg',
                contentType: 'image/jpeg',
                originalSize: 40 * 1024 * 1024,
                blobUrl: null,
                kind: 'image',
                oversized: true,
                hasBytes: false,
            }),
        );

        await useUploadStore.getState().recoverInterrupted(EVENT_SLUG);
        await flush();

        expect(useUploadStore.getState().recoveryNotice).toBe(true);
    });

    it('does NOT raise recoveryNotice for a resumable image (auto-resume)', async () => {
        const { useUploadStore, uploadQueue } = await loadFresh();
        await uploadQueue.put(
            makeRecord({ uploadId: 'img-noticefree', kind: 'image', hasBytes: true, blobUrl: null }),
        );
        await uploadQueue.putBytes(
            'img-noticefree',
            new Blob([new Uint8Array(1000)], { type: 'image/jpeg' }),
        );
        uploadToBlobMock.mockImplementation(() => new Promise(() => {})); // hang so it stays resuming
        stubConfirmFetch(() => ({ ok: true, status: 201, json: mediaDto() }));

        await useUploadStore.getState().recoverInterrupted(EVENT_SLUG);
        await flush();

        expect(useUploadStore.getState().recoveryNotice).toBe(false);
    });
});

describe('recoverInterrupted — cleanup on dismiss', () => {
    it('dismissing a surfaced inert item removes the record AND its (absent) bytes', async () => {
        const { useUploadStore, uploadQueue } = await loadFresh();
        const rec = makeRecord({
            uploadId: 'dismiss-1',
            filename: 'clip.mp4',
            contentType: 'video/mp4',
            blobUrl: null,
            kind: 'video',
            hasBytes: false,
            thumbnailDataUrl: 'data:image/jpeg;base64,CCCC',
        });
        await uploadQueue.put(rec);

        await useUploadStore.getState().recoverInterrupted(EVENT_SLUG);
        await flush();
        expect(useUploadStore.getState().items).toHaveLength(1);

        useUploadStore.getState().dismissItem('dismiss-1');
        await flush();

        expect(useUploadStore.getState().items).toHaveLength(0);
        expect(await uploadQueue.all()).toHaveLength(0);
        expect(await uploadQueue.getBytes('dismiss-1')).toBeNull();
    });
});

// RESTATED byte-persistence invariant (Change 3, ties to P1 + P7):
//   File bytes are persisted ONLY for resumable images (<= cap) and are deleted
//   on confirm/cancel/dismiss; videos and oversized images persist only a
//   thumbnail; auto-resume reuses the SAME uploadId (so re-confirm dedupes — no
//   duplicate row, P1); and nothing is ever silently swallowed (a failed
//   auto-confirm surfaces the record rather than dropping it, P7).
describe('byte-persistence invariant (restated P1/P7)', () => {
    it('a resumable image persists bytes; a video does not (thumbnail only)', async () => {
        const { uploadQueue } = await loadFresh();

        // Simulate what enqueue's policy persists: image <= cap -> bytes.
        await uploadQueue.put(
            makeRecord({ uploadId: 'img-cap', kind: 'image', hasBytes: true }),
        );
        await uploadQueue.putBytes(
            'img-cap',
            new Blob([new Uint8Array(1000)], { type: 'image/jpeg' }),
        );
        // Video -> NO bytes, thumbnail only.
        await uploadQueue.put(
            makeRecord({
                uploadId: 'vid-cap',
                kind: 'video',
                contentType: 'video/mp4',
                hasBytes: false,
                thumbnailDataUrl: 'data:image/jpeg;base64,DDDD',
            }),
        );

        expect(await uploadQueue.getBytes('img-cap')).toBeInstanceOf(Blob);
        expect(await uploadQueue.getBytes('vid-cap')).toBeNull();
    });

    it('confirm success deletes the persisted bytes (no orphaned bytes)', async () => {
        const { useUploadStore, uploadQueue } = await loadFresh();
        await uploadQueue.put(
            makeRecord({ uploadId: 'clean-1', kind: 'image', hasBytes: true }),
        );
        await uploadQueue.putBytes(
            'clean-1',
            new Blob([new Uint8Array(500)], { type: 'image/jpeg' }),
        );

        uploadToBlobMock.mockImplementation(async (args: { uploadId: string }) => ({
            uploadId: args.uploadId,
            blobUrl: `${BLOB_HOST}/events/${EVENT_ID}/${args.uploadId}/photo.jpg`,
            pathname: `events/${EVENT_ID}/${args.uploadId}/photo.jpg`,
            filename: 'photo.jpg',
            contentType: 'image/jpeg',
            originalSize: 500,
            processedSize: 400,
            processed: true,
            blurhash: null,
        }));
        stubConfirmFetch(() => ({ ok: true, status: 201, json: mediaDto() }));

        await useUploadStore.getState().recoverInterrupted(EVENT_SLUG);
        await flush(10);

        expect(await uploadQueue.getBytes('clean-1')).toBeNull();
        expect(await uploadQueue.all()).toHaveLength(0);
    });
});

describe('recoverInterrupted — per-event filtering + run-once', () => {
    it('leaves records for other events untouched', async () => {
        const { useUploadStore, uploadQueue } = await loadFresh();
        await uploadQueue.put(
            makeRecord({ uploadId: 'other-evt', eventSlug: 'a-different-event', blobUrl: null, kind: 'video', hasBytes: false }),
        );

        await useUploadStore.getState().recoverInterrupted(EVENT_SLUG);
        await flush();

        // Not surfaced (different event) and still persisted for its own pass.
        expect(useUploadStore.getState().items).toHaveLength(0);
        expect(await uploadQueue.all()).toHaveLength(1);
    });

    it('is run-once: a second call is a no-op', async () => {
        const { useUploadStore, uploadQueue } = await loadFresh();
        await uploadQueue.put(
            makeRecord({ uploadId: 'once-1', blobUrl: null, kind: 'video', hasBytes: false, contentType: 'video/mp4' }),
        );

        await useUploadStore.getState().recoverInterrupted(EVENT_SLUG);
        await flush();
        const firstCount = useUploadStore.getState().items.length;

        // Add another record and call again — the run-once guard makes it a no-op.
        await uploadQueue.put(
            makeRecord({ uploadId: 'once-2', blobUrl: null, kind: 'video', hasBytes: false, contentType: 'video/mp4' }),
        );
        await useUploadStore.getState().recoverInterrupted(EVENT_SLUG);
        await flush();

        expect(useUploadStore.getState().items.length).toBe(firstCount);
    });
});
