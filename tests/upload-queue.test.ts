// Unit tests for the upload queue (lib/upload-queue.ts) — Task 13.2.
//
// Two faithful modes, both testing the REAL queue logic (no faking of the
// queue's own behavior):
//   1. Round-trip mode: register `fake-indexeddb` as the global `indexedDB` so
//      put/patch/remove/all, immutable-date, and missing-record no-op are
//      exercised against a real IndexedDB implementation.
//   2. Degradation mode: with NO `indexedDB` global, assert put/patch/remove
//      resolve (no-op) and all() -> [] (Req 11.6). This needs no dependency.
//
// The module caches its open-DB promise at module scope and reads the
// `indexedDB` global lazily inside functions. To get isolated state we
// vi.resetModules() and re-import fresh per test, controlling the global before
// each import.
//
// Covered acceptance criteria: Req 6.1 (keyed by uploadId), 6.2 (metadata only),
// 6.4 (persisted fields), 6.5 (remove on confirm), 6.6 (immutable enqueue-time
// date), 11.6 (graceful degradation), 18.2 (error recorded on record).
import {
    describe,
    it,
    expect,
    beforeEach,
    afterEach,
    vi,
} from 'vitest';

type QueueModule = typeof import('@/lib/upload-queue');

function makeRecord(
    uploadId: string,
    overrides: Partial<import('@/lib/upload-queue').QueueRecord> = {},
): import('@/lib/upload-queue').QueueRecord {
    return {
        uploadId,
        eventSlug: 'my-event',
        filename: 'photo.jpg',
        contentType: 'image/jpeg',
        originalSize: 2_000_000,
        processedSize: 400_000,
        status: 'queued',
        blobUrl: null,
        error: null,
        date: '2024-01-15T10:30:00.000Z',
        updatedAt: 0,
        ...overrides,
    };
}

// Load a fresh queue module with a real fake-indexeddb registered as global.
// A brand-new `IDBFactory` is installed each time so the backing database is
// empty per test (fake-indexeddb persists data inside a factory instance, so we
// must swap the factory, not just reset modules).
async function loadQueueWithIndexedDb(): Promise<QueueModule> {
    vi.resetModules();
    const { IDBFactory } = await import('fake-indexeddb');
    vi.stubGlobal('indexedDB', new IDBFactory());
    return import('@/lib/upload-queue');
}

// Load a fresh queue module with NO indexedDB global (degradation path).
async function loadQueueWithoutIndexedDb(): Promise<QueueModule> {
    vi.resetModules();
    vi.stubGlobal('indexedDB', undefined);
    return import('@/lib/upload-queue');
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe('uploadQueue — round-trip with IndexedDB', () => {
    let uploadQueue: QueueModule['uploadQueue'];

    beforeEach(async () => {
        ({ uploadQueue } = await loadQueueWithIndexedDb());
    });

    it('all() returns [] when the store is empty', async () => {
        expect(await uploadQueue.all()).toEqual([]);
    });

    it('put then all() returns the record keyed by uploadId', async () => {
        await uploadQueue.put(makeRecord('id-1'));
        const all = await uploadQueue.all();

        expect(all).toHaveLength(1);
        expect(all[0].uploadId).toBe('id-1');
        expect(all[0].filename).toBe('photo.jpg');
        // updatedAt is managed by the module (refreshed on put).
        expect(typeof all[0].updatedAt).toBe('number');
        expect(all[0].updatedAt).toBeGreaterThan(0);
    });

    // RESTATED INVARIANT (Change 3): the METADATA record still never carries
    // file bytes. Bytes are persisted ONLY for resumable images (<= cap) and
    // ONLY in the SEPARATE `upload-bytes` store (see the bytes-store tests
    // below), and they are deleted on confirm/cancel/dismiss. Videos and
    // oversized images persist only a thumbnail. So "no bytes in metadata"
    // remains true; the metadata store stays a pure intent/metadata log.
    it('persists only the metadata fields and never file bytes in the metadata record', async () => {
        await uploadQueue.put(makeRecord('id-meta'));
        const [rec] = await uploadQueue.all();

        // The core metadata fields set by makeRecord are present; the optional
        // Change-3 fields (kind/hasBytes/oversized/thumbnailDataUrl/blurhash) are
        // absent unless explicitly set (back-compat). None of them is ever a byte
        // payload.
        for (const key of [
            'blobUrl',
            'contentType',
            'date',
            'error',
            'eventSlug',
            'filename',
            'originalSize',
            'processedSize',
            'status',
            'updatedAt',
            'uploadId',
        ]) {
            expect(rec).toHaveProperty(key);
        }
        // No bytes/File/Blob smuggled into the metadata record.
        expect('bytes' in rec).toBe(false);
        expect('file' in rec).toBe(false);
        expect('blob' in rec).toBe(false);
    });

    it('patch merges fields but preserves uploadId', async () => {
        await uploadQueue.put(makeRecord('id-2'));
        await uploadQueue.patch('id-2', {
            status: 'uploading',
            blobUrl: 'https://blob.example.com/x',
            uploadId: 'HACKED', // attempt to change the key — must be ignored
        });

        const [rec] = await uploadQueue.all();
        expect(rec.uploadId).toBe('id-2');
        expect(rec.status).toBe('uploading');
        expect(rec.blobUrl).toBe('https://blob.example.com/x');
    });

    it('patch preserves the immutable enqueue-time date', async () => {
        const originalDate = '2024-01-15T10:30:00.000Z';
        await uploadQueue.put(makeRecord('id-3', { date: originalDate }));
        await uploadQueue.patch('id-3', {
            status: 'failed',
            error: 'network',
            date: '2099-12-31T00:00:00.000Z', // attempt to overwrite — must be ignored
        });

        const [rec] = await uploadQueue.all();
        expect(rec.date).toBe(originalDate);
        expect(rec.status).toBe('failed');
        expect(rec.error).toBe('network');
    });

    it('records the error message on the record via patch (Req 18.2)', async () => {
        await uploadQueue.put(makeRecord('id-err'));
        await uploadQueue.patch('id-err', { status: 'failed', error: 'boom' });

        const [rec] = await uploadQueue.all();
        expect(rec.error).toBe('boom');
    });

    it('patch on a missing record is a no-op resolve (store stays empty)', async () => {
        await expect(
            uploadQueue.patch('does-not-exist', { status: 'failed' }),
        ).resolves.toBeUndefined();
        expect(await uploadQueue.all()).toEqual([]);
    });

    it('remove deletes the record', async () => {
        await uploadQueue.put(makeRecord('id-4'));
        expect(await uploadQueue.all()).toHaveLength(1);

        await uploadQueue.remove('id-4');
        expect(await uploadQueue.all()).toEqual([]);
    });

    it('remove of a missing key resolves without error', async () => {
        await expect(uploadQueue.remove('nope')).resolves.toBeUndefined();
    });

    it('put upserts an existing record by key (no duplicates)', async () => {
        await uploadQueue.put(makeRecord('id-5', { status: 'queued' }));
        await uploadQueue.put(makeRecord('id-5', { status: 'completed' }));

        const all = await uploadQueue.all();
        expect(all).toHaveLength(1);
        expect(all[0].status).toBe('completed');
    });

    // --- Change 3: separate bytes store (resumable images only) --------------

    it('putBytes then getBytes round-trips the blob', async () => {
        const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/jpeg' });
        await uploadQueue.putBytes('id-bytes', blob);

        const back = await uploadQueue.getBytes('id-bytes');
        expect(back).toBeInstanceOf(Blob);
        expect(await (back as Blob).arrayBuffer()).toEqual(await blob.arrayBuffer());
        expect((back as Blob).type).toBe('image/jpeg');
    });

    it('getBytes returns null when no bytes were persisted', async () => {
        expect(await uploadQueue.getBytes('never-stored')).toBeNull();
    });

    it('bytes live in a separate store — all() metadata never carries bytes', async () => {
        await uploadQueue.put(makeRecord('id-sep'));
        await uploadQueue.putBytes('id-sep', new Blob([new Uint8Array(8)]));

        const [rec] = await uploadQueue.all();
        expect('bytes' in rec).toBe(false);
        expect('blob' in rec).toBe(false);
        // Bytes are still retrievable from the dedicated store.
        expect(await uploadQueue.getBytes('id-sep')).toBeInstanceOf(Blob);
    });

    it('removeBytes deletes only the bytes, leaving the metadata record', async () => {
        await uploadQueue.put(makeRecord('id-rb'));
        await uploadQueue.putBytes('id-rb', new Blob([new Uint8Array(4)]));

        await uploadQueue.removeBytes('id-rb');
        expect(await uploadQueue.getBytes('id-rb')).toBeNull();
        // Metadata record still present.
        expect(await uploadQueue.all()).toHaveLength(1);
    });

    it('remove() cleans up BOTH the metadata record and the persisted bytes', async () => {
        await uploadQueue.put(makeRecord('id-both'));
        await uploadQueue.putBytes('id-both', new Blob([new Uint8Array(4)]));

        await uploadQueue.remove('id-both');
        expect(await uploadQueue.all()).toEqual([]);
        expect(await uploadQueue.getBytes('id-both')).toBeNull();
    });

    it('removeBytes of a missing key resolves without error', async () => {
        await expect(uploadQueue.removeBytes('nope')).resolves.toBeUndefined();
    });

    it('persists optional recovery-UX metadata fields when provided', async () => {
        await uploadQueue.put(
            makeRecord('id-meta2', {
                kind: 'video',
                hasBytes: false,
                oversized: false,
                thumbnailDataUrl: 'data:image/png;base64,AAA',
            }),
        );
        const [rec] = await uploadQueue.all();
        expect(rec.kind).toBe('video');
        expect(rec.hasBytes).toBe(false);
        expect(rec.oversized).toBe(false);
        expect(rec.thumbnailDataUrl).toBe('data:image/png;base64,AAA');
    });
});

describe('uploadQueue — recreate after the database is deleted', () => {
    it('recreates the DB + stores on the next op after deleteDatabase, so data persists again', async () => {
        const { IDBFactory } = await import('fake-indexeddb');
        const factory = new IDBFactory();
        vi.resetModules();
        vi.stubGlobal('indexedDB', factory);
        const { uploadQueue } = await import('@/lib/upload-queue');

        // Write something so a connection is opened + cached.
        await uploadQueue.put(makeRecord('before'));
        expect(await uploadQueue.all()).toHaveLength(1);

        // Simulate the user deleting the IndexedDB (devtools / clear site data).
        // Deleting fires versionchange/close on the open connection; our
        // onversionchange/onclose handlers drop the cached promise so the next
        // op re-opens and re-creates the stores.
        await new Promise<void>((resolve) => {
            const req = factory.deleteDatabase('golden-core-uploads');
            req.onsuccess = () => resolve();
            req.onerror = () => resolve();
            req.onblocked = () => resolve();
        });

        // The next op must NOT silently no-op forever: it re-opens (recreating
        // the DB and its object stores) and persists again.
        await uploadQueue.put(makeRecord('after'));
        const all = await uploadQueue.all();
        expect(all.map((r) => r.uploadId)).toContain('after');

        // Bytes store is recreated too (resume relies on it).
        await uploadQueue.putBytes('after', new Blob([new Uint8Array(8)], { type: 'image/jpeg' }));
        expect(await uploadQueue.getBytes('after')).toBeInstanceOf(Blob);
    });
});

describe('uploadQueue — graceful degradation without IndexedDB', () => {
    let uploadQueue: QueueModule['uploadQueue'];

    beforeEach(async () => {
        ({ uploadQueue } = await loadQueueWithoutIndexedDb());
    });

    it('all() resolves to [] when IndexedDB is unavailable', async () => {
        expect(await uploadQueue.all()).toEqual([]);
    });

    it('put resolves (no-op) when IndexedDB is unavailable', async () => {
        await expect(uploadQueue.put(makeRecord('id-x'))).resolves.toBeUndefined();
        expect(await uploadQueue.all()).toEqual([]);
    });

    it('patch resolves (no-op) when IndexedDB is unavailable', async () => {
        await expect(
            uploadQueue.patch('id-x', { status: 'failed' }),
        ).resolves.toBeUndefined();
    });

    it('remove resolves (no-op) when IndexedDB is unavailable', async () => {
        await expect(uploadQueue.remove('id-x')).resolves.toBeUndefined();
    });

    it('putBytes resolves (no-op) when IndexedDB is unavailable', async () => {
        await expect(
            uploadQueue.putBytes('id-x', new Blob([new Uint8Array(4)])),
        ).resolves.toBeUndefined();
    });

    it('getBytes resolves to null when IndexedDB is unavailable', async () => {
        expect(await uploadQueue.getBytes('id-x')).toBeNull();
    });

    it('removeBytes resolves (no-op) when IndexedDB is unavailable', async () => {
        await expect(uploadQueue.removeBytes('id-x')).resolves.toBeUndefined();
    });
});
