// Focused end-to-end-ish repro of the mid-upload refresh -> auto-resume flow,
// against the REAL upload store + REAL fake-indexeddb queue. Mocks only the
// network boundary (uploadToBlob + fetch). This asserts that after an upload is
// enqueued and gets mid-flight (bytes persisted, metadata record 'uploading'
// with blobUrl null), a fresh store instance (simulating a page reload) auto-
// resumes it: reuses the SAME uploadId, drives uploadToBlob + confirm, and
// completes — with the event loaded first.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { uploadToBlobMock } = vi.hoisted(() => ({ uploadToBlobMock: vi.fn() }));

vi.mock('@/lib/blob-upload-client', () => ({
    uploadToBlob: (...args: unknown[]) => uploadToBlobMock(...args),
}));
vi.mock('axios', () => ({
    default: { get: vi.fn(async () => ({ data: {} })), post: vi.fn(async () => ({ data: {} })) },
}));

const EVENT_SLUG = 'my-event';
const EVENT_ID = 12;
const SECTION_ID = 99;
const BLOB_HOST = 'https://blob.example.com';

type StoreModule = typeof import('@/app/src/stores/upload.store');
type QueueModule = typeof import('@/lib/upload-queue');
type EventModule = typeof import('@/app/src/stores/event.store');

async function loadModules(factory: unknown) {
    vi.resetModules();
    vi.stubGlobal('indexedDB', factory);
    const queueMod = (await import('@/lib/upload-queue')) as QueueModule;
    const eventMod = (await import('@/app/src/stores/event.store')) as EventModule;
    const storeMod = (await import('@/app/src/stores/upload.store')) as StoreModule;
    return { queueMod, eventMod, storeMod };
}

function seedEvent(eventMod: EventModule) {
    eventMod.default.setState({
        event: {
            event_id: EVENT_ID,
            event_name: 'Test',
            event_slug: EVENT_SLUG,
            event_date: '2024-01-01',
            sections: [
                { section_id: SECTION_ID, section_name: 'Sin clasificar', start_date: '', finish_date: '', media: [] },
            ],
        } as never,
        loading: false,
    });
}

function mediaDto(over: Record<string, unknown> = {}) {
    return {
        media_id: 999, user_id: 5, content: `${BLOB_HOST}/x.jpg`, type: 'image/jpeg',
        likes: 0, liked: false, date: '2024-01-15T10:30:00.000Z', section_id: SECTION_ID,
        blurhash: null, username: 'tester', ...over,
    };
}

async function flush(times = 12) {
    for (let i = 0; i < times; i++) {
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
    }
}

beforeEach(() => {
    vi.stubGlobal('window', { location: { pathname: `/${EVENT_SLUG}` } });
    let n = 0;
    (URL as unknown as { createObjectURL?: (b: Blob) => string }).createObjectURL = () => `blob:mock-${n++}`;
    (URL as unknown as { revokeObjectURL?: (u: string) => void }).revokeObjectURL = () => {};
    if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.randomUUID) {
        vi.stubGlobal('crypto', { randomUUID: () => '99999999-9999-4999-8999-999999999999' });
    }
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.resetModules();
});

describe('mid-upload refresh -> transparent auto-resume (e2e)', () => {
    it('persists bytes + metadata during upload, then a fresh store resumes the SAME uploadId', async () => {
        const { IDBFactory } = await import('fake-indexeddb');
        // ONE shared backing factory across both "page loads" (simulates the
        // browser's persistent IndexedDB surviving a reload).
        const factory = new IDBFactory();

        // ---- Page load #1: enqueue an image; upload hangs mid-flight. ----
        let firstStore: StoreModule['default'];
        let uploadId = '';
        {
            const { eventMod, storeMod } = await loadModules(factory);
            seedEvent(eventMod);
            firstStore = storeMod.default;

            // uploadToBlob hangs forever (simulates an in-flight upload the user
            // interrupts by refreshing).
            uploadToBlobMock.mockImplementation(() => new Promise(() => {}));

            const file = new File([new Uint8Array(1_000_000)], 'photo.jpg', { type: 'image/jpeg' });
            firstStore.getState().enqueueFiles([file], EVENT_SLUG);
            await flush();

            const items = firstStore.getState().items;
            expect(items).toHaveLength(1);
            uploadId = items[0].id;
            expect(items[0].status).toBe('uploading');
        }

        // The persisted state must be present in IndexedDB for recovery to work.
        {
            const { queueMod } = await loadModules(factory);
            const records = await queueMod.uploadQueue.all();
            expect(records).toHaveLength(1);
            const r = records[0];
            expect(r.uploadId).toBe(uploadId);
            expect(r.blobUrl).toBeNull();
            expect(r.hasBytes).toBe(true);
            expect(r.kind).toBe('image');
            // The actual bytes were persisted for resume.
            expect(await queueMod.uploadQueue.getBytes(uploadId)).toBeInstanceOf(Blob);
        }

        // ---- Page load #2: fresh store (module reset) recovers + auto-resumes. ----
        {
            const { eventMod, storeMod } = await loadModules(factory);
            seedEvent(eventMod);
            const store = storeMod.default;

            // Reset call history from page load #1 (the hanging attempt).
            uploadToBlobMock.mockClear();
            // Now the upload succeeds and confirm returns a Media DTO.
            uploadToBlobMock.mockImplementation(async (args: { uploadId: string }) => ({
                uploadId: args.uploadId,
                blobUrl: `${BLOB_HOST}/events/${EVENT_ID}/${args.uploadId}/photo.jpg`,
                pathname: `events/${EVENT_ID}/${args.uploadId}/photo.jpg`,
                filename: 'photo.jpg', contentType: 'image/jpeg',
                originalSize: 1_000_000, processedSize: 800_000, processed: true, blurhash: null,
            }));
            const confirmIds: string[] = [];
            vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
                const body = init?.body ? JSON.parse(init.body as string) : {};
                confirmIds.push(body.uploadId);
                return { ok: true, status: 201, json: async () => mediaDto({ media_id: 4242 }) } as Response;
            }));

            await store.getState().recoverInterrupted(EVENT_SLUG);
            await flush(20);

            // uploadToBlob was called with the SAME uploadId (resume, not new).
            expect(uploadToBlobMock).toHaveBeenCalledTimes(1);
            expect(uploadToBlobMock.mock.calls[0][0].uploadId).toBe(uploadId);
            // Confirm used the same uploadId; media appended; record+bytes gone.
            expect(confirmIds).toEqual([uploadId]);
            const media = eventMod.default.getState().event!.sections[0].media;
            expect(media.some((m) => m.media_id === 4242)).toBe(true);
            expect(await storeMod.default.getState().items.find((i) => i.id === uploadId)?.status).toBe('success');
        }
    });

    it('a QUEUED item (behind MAX_CONCURRENT) also persists a record + bytes and is recoverable', async () => {
        const { IDBFactory } = await import('fake-indexeddb');
        const factory = new IDBFactory();

        // 5 images while uploadToBlob hangs -> 3 go 'uploading', 2 stay 'queued'.
        let ids: string[] = [];
        let queuedIds: string[] = [];
        {
            const { eventMod, storeMod } = await loadModules(factory);
            seedEvent(eventMod);
            uploadToBlobMock.mockImplementation(() => new Promise(() => {}));

            const files = Array.from({ length: 5 }, (_, i) =>
                new File([new Uint8Array(500_000)], `p${i}.jpg`, { type: 'image/jpeg' }),
            );
            storeMod.default.getState().enqueueFiles(files, EVENT_SLUG);
            await flush();

            const items = storeMod.default.getState().items;
            expect(items).toHaveLength(5);
            ids = items.map((i) => i.id);
            queuedIds = items.filter((i) => i.status === 'queued').map((i) => i.id);
            const uploadingIds = items.filter((i) => i.status === 'uploading').map((i) => i.id);
            // Exactly 3 active, 2 queued (MAX_CONCURRENT = 3).
            expect(uploadingIds).toHaveLength(3);
            expect(queuedIds).toHaveLength(2);
        }

        // ALL 5 (queued included) must have a persisted metadata record + bytes,
        // otherwise the queued ones would vanish on reload.
        {
            const { queueMod } = await loadModules(factory);
            const records = await queueMod.uploadQueue.all();
            expect(records.map((r) => r.uploadId).sort()).toEqual([...ids].sort());
            for (const r of records) {
                expect(r.blobUrl).toBeNull();
                expect(r.hasBytes).toBe(true);
            }
            for (const qid of queuedIds) {
                expect(await queueMod.uploadQueue.getBytes(qid)).toBeInstanceOf(Blob);
            }
        }
    });
});
