// ---------------------------------------------------------------------------
// upload-store.analytics.test.ts — GA4 upload event instrumentation.
//
// Verifies that the upload store emits the correct GA4 events (via the
// `trackEvent` helper in app/src/lib/analytics.ts) at the correct points in the
// upload lifecycle, WITHOUT changing any upload behavior. `trackEvent` is mocked
// so we assert only the analytics side effects (name + params); the rest of the
// store (queue, event store, attempt guard, concurrency) runs for real against a
// fake IndexedDB, mirroring upload-store.recovery.test.ts.
//
// Key properties asserted:
//   * upload_started fires when an attempt actually begins (startItem), NOT on
//     enqueue.
//   * upload_completed fires ONLY after confirm succeeds (a resolved Blob upload
//     with a FAILED confirm must NOT emit upload_completed — instead
//     upload_failed).
//   * upload_failed fires once per failed attempt.
//   * upload_canceled fires on a real cancel and NOT on a canceled success.
//   * upload_retry fires only for a valid retry (retryable state).
//   * upload_confirm_retry fires when retryConfirm attempts the POST.
//   * upload_recovered (recovery_type: confirm_only) fires on confirm-only
//     recovery success.
//   * No sensitive params (filename / blobUrl) are ever sent.
//
// Runs in the default `node` environment (no jsdom). Browser globals used on
// these paths (window.location, URL.createObjectURL/revoke, fetch, indexedDB)
// are stubbed below; crypto.randomUUID / File / Blob are Node 20 natives.
// ---------------------------------------------------------------------------

import {
    describe,
    it,
    expect,
    beforeEach,
    afterEach,
    vi,
} from 'vitest';

// --- Hoisted mock holders ----------------------------------------------------
const { uploadToBlobMock, trackEventMock } = vi.hoisted(() => ({
    uploadToBlobMock: vi.fn(),
    trackEventMock: vi.fn(),
}));

vi.mock('@/lib/blob-upload-client', () => ({
    uploadToBlob: (...args: unknown[]) => uploadToBlobMock(...args),
}));

// Mock the analytics helper so we can assert the events the store emits without
// touching a real GA/dataLayer. This is the boundary under test.
vi.mock('@/app/src/lib/analytics', () => ({
    trackEvent: (...args: unknown[]) => trackEventMock(...args),
}));

// axios is imported by event/auth stores; stub it so nothing hits the network.
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

async function flush(times = 8): Promise<void> {
    for (let i = 0; i < times; i++) {
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
    }
}

/** All (name, params) pairs recorded for a given event name. */
function eventsOf(name: string): Array<Record<string, unknown>> {
    return trackEventMock.mock.calls
        .filter((c) => c[0] === name)
        .map((c) => (c[1] ?? {}) as Record<string, unknown>);
}

/** Count of emitted events with a given name. */
function countOf(name: string): number {
    return trackEventMock.mock.calls.filter((c) => c[0] === name).length;
}

/** A small in-memory image File so enqueue drives a real upload. */
function imageFile(name = 'photo.jpg', bytes = 1000): File {
    return new File([new Uint8Array(bytes)], name, { type: 'image/jpeg' });
}

/** Standard successful uploadToBlob result. */
function blobOk(uploadId: string) {
    return {
        uploadId,
        blobUrl: `${BLOB_HOST}/events/${EVENT_ID}/${uploadId}/photo.jpg`,
        pathname: `events/${EVENT_ID}/${uploadId}/photo.jpg`,
        filename: 'photo.jpg',
        contentType: 'image/jpeg',
        originalSize: 1000,
        processedSize: 800,
        processed: true,
        blurhash: 'LEHV6nWB2yk8',
    };
}

beforeEach(() => {
    vi.stubGlobal('window', {
        location: { pathname: `/${EVENT_SLUG}` },
        // enqueueFiles / auth store may reference these; harmless stubs.
        addEventListener: () => {},
        navigator: { onLine: true },
    });
    vi.stubGlobal('navigator', { onLine: true });
    let urlCounter = 0;
    (URL as unknown as { createObjectURL?: (b: Blob) => string }).createObjectURL =
        () => `blob:mock-${urlCounter++}`;
    (URL as unknown as { revokeObjectURL?: (u: string) => void }).revokeObjectURL =
        () => {};
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

// ---------------------------------------------------------------------------

describe('analytics — upload_started', () => {
    it('does NOT fire on enqueue alone but fires once when the attempt starts', async () => {
        const { useUploadStore } = await loadFresh();

        // Never resolve the blob upload so the attempt stays in-flight; this lets
        // us observe upload_started without a completion racing in.
        uploadToBlobMock.mockImplementation(() => new Promise(() => {}));

        useUploadStore.getState().enqueueFiles([imageFile()], EVENT_SLUG);
        await flush(2);

        const started = eventsOf('upload_started');
        expect(started).toHaveLength(1);
        expect(started[0].upload_id).toEqual(expect.any(String));
        expect(started[0].event_slug).toBe(EVENT_SLUG);
        expect(started[0].content_type).toBe('image/jpeg');
        expect(started[0].file_size).toBe(1000);
        // Never leak sensitive fields.
        expect(started[0]).not.toHaveProperty('filename');
        expect(started[0]).not.toHaveProperty('blobUrl');
    });
});

describe('analytics — upload_completed (confirm-gated)', () => {
    it('fires ONLY after confirm succeeds', async () => {
        const { useUploadStore } = await loadFresh();
        uploadToBlobMock.mockImplementation(async (a: { uploadId: string }) =>
            blobOk(a.uploadId),
        );
        stubConfirmFetch(() => ({ ok: true, status: 201, json: mediaDto() }));

        useUploadStore.getState().enqueueFiles([imageFile()], EVENT_SLUG);
        await flush(12);

        expect(countOf('upload_completed')).toBe(1);
        expect(countOf('upload_failed')).toBe(0);
        const done = eventsOf('upload_completed')[0];
        expect(done.processed_size).toBe(800);
        expect(done).not.toHaveProperty('blobUrl');
    });

    it('a SUCCESSFUL Blob upload with a FAILED confirm does NOT emit upload_completed (emits upload_failed)', async () => {
        const { useUploadStore } = await loadFresh();
        uploadToBlobMock.mockImplementation(async (a: { uploadId: string }) =>
            blobOk(a.uploadId),
        );
        // Blob resolves fine, but confirm returns 500.
        stubConfirmFetch(() => ({ ok: false, status: 500, json: {} }));

        useUploadStore.getState().enqueueFiles([imageFile()], EVENT_SLUG);
        await flush(12);

        expect(countOf('upload_completed')).toBe(0);
        expect(countOf('upload_failed')).toBe(1);
    });
});

describe('analytics — upload_failed', () => {
    it('fires exactly once when the Blob upload itself fails', async () => {
        const { useUploadStore } = await loadFresh();
        uploadToBlobMock.mockRejectedValue(new Error('network boom'));

        useUploadStore.getState().enqueueFiles([imageFile()], EVENT_SLUG);
        await flush(12);

        expect(countOf('upload_failed')).toBe(1);
        expect(countOf('upload_completed')).toBe(0);
    });
});

describe('analytics — upload_canceled', () => {
    it('fires when a queued item is canceled', async () => {
        const { useUploadStore } = await loadFresh();
        uploadToBlobMock.mockImplementation(() => new Promise(() => {}));

        // Fill the 3 concurrency slots so the 4th stays queued.
        useUploadStore
            .getState()
            .enqueueFiles(
                [imageFile('a.jpg'), imageFile('b.jpg'), imageFile('c.jpg'), imageFile('d.jpg')],
                EVENT_SLUG,
            );
        await flush(2);

        const queued = useUploadStore.getState().items.find((i) => i.status === 'queued');
        expect(queued).toBeDefined();
        useUploadStore.getState().cancelItem(queued!.id);
        await flush(2);

        expect(countOf('upload_canceled')).toBe(1);
    });

    it('does NOT fire when canceling an already-successful item', async () => {
        const { useUploadStore } = await loadFresh();
        uploadToBlobMock.mockImplementation(async (a: { uploadId: string }) =>
            blobOk(a.uploadId),
        );
        stubConfirmFetch(() => ({ ok: true, status: 201, json: mediaDto() }));

        useUploadStore.getState().enqueueFiles([imageFile()], EVENT_SLUG);
        await flush(12);

        const success = useUploadStore.getState().items.find((i) => i.status === 'success');
        expect(success).toBeDefined();
        trackEventMock.mockClear();
        useUploadStore.getState().cancelItem(success!.id);
        await flush(2);

        expect(countOf('upload_canceled')).toBe(0);
    });
});

describe('analytics — upload_retry', () => {
    it('fires when retrying a failed item, but NOT for a non-retryable state', async () => {
        const { useUploadStore } = await loadFresh();
        // First attempt fails.
        uploadToBlobMock.mockRejectedValueOnce(new Error('boom'));

        useUploadStore.getState().enqueueFiles([imageFile()], EVENT_SLUG);
        await flush(12);

        const failed = useUploadStore.getState().items.find((i) => i.status === 'failed');
        expect(failed).toBeDefined();

        // Retry now succeeds so the retry actually starts.
        uploadToBlobMock.mockImplementation(async (a: { uploadId: string }) =>
            blobOk(a.uploadId),
        );
        stubConfirmFetch(() => ({ ok: true, status: 201, json: mediaDto() }));

        trackEventMock.mockClear();
        useUploadStore.getState().retryItem(failed!.id);
        await flush(12);

        expect(countOf('upload_retry')).toBe(1);

        // A second retry on the now-successful item must NOT emit upload_retry.
        trackEventMock.mockClear();
        useUploadStore.getState().retryItem(failed!.id);
        await flush(2);
        expect(countOf('upload_retry')).toBe(0);
    });
});

describe('analytics — upload_confirm_retry + upload_recovered (confirm_only)', () => {
    it('fires upload_confirm_retry on the POST and upload_recovered on success', async () => {
        const { useUploadStore, uploadQueue } = await loadFresh();
        // Surface a confirm-retry recovery item: a record with a blobUrl but a
        // confirm that fails during recovery.
        const rec = makeRecord({
            uploadId: 'blob-x',
            blobUrl: `${BLOB_HOST}/events/${EVENT_ID}/blob-x/photo.jpg`,
        });
        await uploadQueue.put(rec);
        stubConfirmFetch(() => ({ ok: false, status: 500, json: {} }));

        await useUploadStore.getState().recoverInterrupted(EVENT_SLUG);
        await flush(8);

        const item = useUploadStore.getState().items.find((i) => i.id === 'blob-x');
        expect(item?.recovery).toBe('confirm-retry');

        // Now the confirm succeeds on the user-driven retry.
        stubConfirmFetch(() => ({ ok: true, status: 201, json: mediaDto({ media_id: 909 }) }));
        trackEventMock.mockClear();
        useUploadStore.getState().retryConfirm('blob-x');
        await flush(8);

        expect(countOf('upload_confirm_retry')).toBe(1);
        expect(countOf('upload_recovered')).toBe(1);
        const rec2 = eventsOf('upload_recovered')[0];
        expect(rec2.recovery_type).toBe('confirm_only');
        expect(rec2.upload_id).toBe('blob-x');
    });

    it('confirm-only recovery success emits upload_recovered (confirm_only)', async () => {
        const { useUploadStore, uploadQueue } = await loadFresh();
        const rec = makeRecord({
            uploadId: 'blob-ok',
            blobUrl: `${BLOB_HOST}/events/${EVENT_ID}/blob-ok/photo.jpg`,
        });
        await uploadQueue.put(rec);
        stubConfirmFetch(() => ({ ok: true, status: 201, json: mediaDto({ media_id: 777 }) }));

        await useUploadStore.getState().recoverInterrupted(EVENT_SLUG);
        await flush(8);

        const recovered = eventsOf('upload_recovered');
        expect(recovered).toHaveLength(1);
        expect(recovered[0].recovery_type).toBe('confirm_only');
        expect(recovered[0].upload_id).toBe('blob-ok');
        expect(countOf('upload_completed')).toBe(0);
    });
});
