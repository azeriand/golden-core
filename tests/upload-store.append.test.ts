// Regression test for appendMediaToEventStore placement (via the same-session
// upload success path). Verifies that a confirmed media row is optimistically
// placed in the SAME section the server (GET) would use on refresh:
//   - classified (real section_id) -> that section
//   - unclassified (section_id null) -> the synthetic "Sin clasificar" section,
//     created on the fly — NEVER dumped into sections[0].
//
// This guards the bug where every unclassified upload was shown in the first
// (earliest) real section and then "disappeared" on refresh once GET grouped it
// under "Sin clasificar".
//
// Runs in node; stubs the same browser globals the recovery test does and mocks
// only uploadToBlob + fetch (confirm). exifr is lazily imported by the store's
// creation-time extraction; we mock @/lib/media-metadata so enqueue does not try
// to parse the dummy file.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { uploadToBlobMock } = vi.hoisted(() => ({ uploadToBlobMock: vi.fn() }));

vi.mock('@/lib/blob-upload-client', () => ({
    uploadToBlob: (...args: unknown[]) => uploadToBlobMock(...args),
}));
vi.mock('axios', () => ({
    default: { get: vi.fn(async () => ({ data: {} })), post: vi.fn(async () => ({ data: {} })) },
}));
// Keep extraction deterministic + side-effect free (no exifr) in the store path.
vi.mock('@/lib/media-metadata', () => ({
    extractCreationTime: vi.fn(async () => null),
}));

const EVENT_SLUG = 'my-event';
const EVENT_ID = 12;
const REAL_SECTION_ID = 77; // an "11:00" section, first in the list
const BLOB_HOST = 'https://blob.example.com';

type StoreModule = typeof import('@/app/src/stores/upload.store');
type EventModule = typeof import('@/app/src/stores/event.store');

async function loadFresh() {
    vi.resetModules();
    const { IDBFactory } = await import('fake-indexeddb');
    vi.stubGlobal('indexedDB', new IDBFactory());

    const eventMod = (await import('@/app/src/stores/event.store')) as EventModule;
    const storeMod = (await import('@/app/src/stores/upload.store')) as StoreModule;

    // Seed an event with a SINGLE real section and NO "Sin clasificar" section.
    eventMod.default.setState({
        event: {
            event_id: EVENT_ID,
            event_name: 'Test',
            event_slug: EVENT_SLUG,
            event_date: '2024-01-01',
            sections: [
                {
                    section_id: REAL_SECTION_ID,
                    section_name: '11:00',
                    start_date: '2026-09-03 11:00:00',
                    finish_date: '2026-09-03 11:59:00',
                    media: [],
                },
            ],
        } as never,
        loading: false,
    });

    return { useUploadStore: storeMod.default, useEventStore: eventMod.default };
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
        section_id: null,
        blurhash: null,
        username: 'tester',
        ...over,
    };
}

async function flush(times = 8): Promise<void> {
    for (let i = 0; i < times; i++) {
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
    }
}

beforeEach(() => {
    vi.stubGlobal('window', { location: { pathname: `/${EVENT_SLUG}` } });
    const RealURL = URL;
    vi.stubGlobal(
        'URL',
        Object.assign(
            function (this: unknown, ...a: unknown[]) {
                return new (RealURL as unknown as new (...x: unknown[]) => object)(...a);
            } as unknown as typeof URL,
            {
                createObjectURL: vi.fn(() => 'blob:mock'),
                revokeObjectURL: vi.fn(),
            },
        ),
    );
    uploadToBlobMock.mockReset();
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/** Drive one file through the store's same-session success path. */
async function uploadOne(
    useUploadStore: StoreModule['default'],
    confirmSectionId: number | null,
): Promise<void> {
    uploadToBlobMock.mockResolvedValue({
        uploadId: 'u',
        blobUrl: `${BLOB_HOST}/events/${EVENT_ID}/x/photo.jpg`,
        pathname: `events/${EVENT_ID}/x/photo.jpg`,
        filename: 'photo.jpg',
        contentType: 'image/jpeg',
        originalSize: 1000,
        processedSize: 800,
        processed: true,
        blurhash: null,
    });
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
            ok: true,
            status: 201,
            json: async () => mediaDto({ section_id: confirmSectionId }),
        })) as never,
    );

    const file = new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' });
    useUploadStore.getState().enqueueFiles([file], EVENT_SLUG);
    await flush();
}

describe('appendMediaToEventStore placement', () => {
    it('routes unclassified media to a synthesized "Sin clasificar" section, not sections[0]', async () => {
        const { useUploadStore, useEventStore } = await loadFresh();

        await uploadOne(useUploadStore, null);

        const sections = useEventStore.getState().event!.sections;
        const real = sections.find((s) => String(s.section_id) === String(REAL_SECTION_ID))!;
        const fallback = sections.find((s) => s.section_name === 'Sin clasificar');

        // The real (first) section must NOT have received the unclassified media.
        expect(real.media).toHaveLength(0);
        // A "Sin clasificar" section was created and holds the media.
        expect(fallback).toBeTruthy();
        expect(fallback!.media.map((m) => m.media_id)).toContain(501);
    });

    it('routes classified media to its real section', async () => {
        const { useUploadStore, useEventStore } = await loadFresh();

        await uploadOne(useUploadStore, REAL_SECTION_ID);

        const sections = useEventStore.getState().event!.sections;
        const real = sections.find((s) => String(s.section_id) === String(REAL_SECTION_ID))!;
        expect(real.media.map((m) => m.media_id)).toContain(501);
        // No spurious "Sin clasificar" section created for classified media.
        expect(sections.find((s) => s.section_name === 'Sin clasificar')).toBeFalsy();
    });
});
