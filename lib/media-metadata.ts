import exifr from "exifr";

/**
 * Formats a Date's time-of-day as an "HH:MM" string using UTC getters.
 *
 * EXIF dates parsed by exifr are returned as JS Date objects whose UTC fields
 * hold the original wall-clock components (exifr does not shift them by the
 * server timezone). Reading them back with the UTC getters gives the original
 * clock time regardless of where the server runs. The video parser below also
 * builds its Date from UTC components, so the same formatter applies.
 */
function formatTimeOfDay(date: Date): string {
    const hours = String(date.getUTCHours()).padStart(2, "0");
    const minutes = String(date.getUTCMinutes()).padStart(2, "0");
    return `${hours}:${minutes}`;
}

/**
 * Applies a "+HH:MM" / "-HH:MM" EXIF offset to a Date, returning a new Date
 * whose UTC clock fields represent the local wall-clock time.
 */
function applyOffset(date: Date, offset: string): Date {
    const match = /^([+-])(\d{2}):(\d{2})$/.exec(offset.trim());
    if (!match) {
        return date;
    }
    const sign = match[1] === "-" ? -1 : 1;
    const offsetMinutes = sign * (Number(match[2]) * 60 + Number(match[3]));
    return new Date(date.getTime() + offsetMinutes * 60 * 1000);
}

/**
 * Extracts the local creation time-of-day from an image's EXIF metadata.
 *
 * Prefers DateTimeOriginal (the capture moment), falling back to CreateDate
 * and ModifyDate. When an EXIF offset is present the time is shifted to the
 * original local wall-clock time.
 */
async function extractImageTime(arrayBuffer: ArrayBuffer): Promise<Date | null> {
    const metadata = await exifr.parse(arrayBuffer, { translateValues: true });
    if (!metadata) {
        return null;
    }

    const candidates = [metadata.DateTimeOriginal, metadata.CreateDate, metadata.ModifyDate];
    const capture = candidates.find((c) => c instanceof Date && !isNaN(c.getTime())) as Date | undefined;
    if (!capture) {
        return null;
    }

    const offset = metadata.OffsetTimeOriginal ?? metadata.OffsetTime;
    return typeof offset === "string" ? applyOffset(capture, offset) : capture;
}

// Seconds between 1904-01-01 (QuickTime/MP4 epoch) and 1970-01-01 (Unix epoch).
const MP4_EPOCH_OFFSET_SECONDS = 2_082_844_800;

// Locates a direct child box by type within [start, end) of an ISO BMFF buffer.
// Returns the content range (payload after the box header) or null.
function findBox(
    view: DataView,
    type: string,
    start: number,
    end: number,
): { start: number; end: number } | null {
    let offset = start;
    while (offset + 8 <= end) {
        const size = view.getUint32(offset);
        const boxType = String.fromCharCode(
            view.getUint8(offset + 4),
            view.getUint8(offset + 5),
            view.getUint8(offset + 6),
            view.getUint8(offset + 7),
        );

        let headerSize = 8;
        let boxSize = size;
        if (size === 1) {
            // 64-bit extended size.
            if (offset + 16 > end) break;
            const high = view.getUint32(offset + 8);
            const low = view.getUint32(offset + 12);
            boxSize = high * 2 ** 32 + low;
            headerSize = 16;
        } else if (size === 0) {
            // Box extends to the end of the parent.
            boxSize = end - offset;
        }

        if (boxSize < headerSize || offset + boxSize > end) {
            break;
        }

        if (boxType === type) {
            return { start: offset + headerSize, end: offset + boxSize };
        }
        offset += boxSize;
    }
    return null;
}

/**
 * Reads the Apple `com.apple.quicktime.creationdate` metadata value, which
 * holds the *local* capture time with a timezone offset (e.g.
 * "2024-06-01T21:35:00+0200"). iOS writes this on every video; recent Android
 * camera apps do too. This is the most reliable local time for a video.
 *
 * The value lives under `moov > meta`, described by parallel `keys` (tag names)
 * and `ilst` (values) boxes. We find the index of the creationdate key, then
 * read the matching entry from `ilst`. Rather than fully decoding both boxes,
 * we scan the `meta` payload for the ISO-8601 date string directly, which is
 * robust across the small layout differences between vendors.
 */
function extractQuickTimeCreationDate(view: DataView, moovStart: number, moovEnd: number): Date | null {
    const meta = findBox(view, "meta", moovStart, moovEnd);
    if (!meta) {
        return null;
    }

    // Decode the meta payload as Latin-1 and look for the ISO-8601 timestamp
    // stored for the creationdate key. The value is plain ASCII text.
    let text = "";
    for (let i = meta.start; i < meta.end; i++) {
        text += String.fromCharCode(view.getUint8(i));
    }

    // e.g. 2024-06-01T21:35:00+0200 / ...-0700 / ...+02:00 / ...Z
    const match = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/.exec(text);
    if (!match) {
        return null;
    }

    return parseQuickTimeDate(match[0]);
}

/**
 * Parses an Apple creationdate string into a Date whose UTC clock fields hold
 * the *local* wall-clock time (so formatTimeOfDay reads back the local hour).
 *
 * When an offset is present we normalize to that local time; a trailing "Z"
 * (or no zone) is treated as already being the intended wall-clock time.
 */
function parseQuickTimeDate(value: string): Date | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:[.,]\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(value);
    if (!m) {
        return null;
    }
    const [, y, mo, d, h, mi, s] = m;

    // The captured components are already the local wall-clock time. Store them
    // as UTC fields so formatTimeOfDay reads back the local hour unchanged; the
    // timezone suffix itself is not needed for time-of-day categorization.
    const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
    const date = new Date(ms);
    return isNaN(date.getTime()) ? null : date;
}

/**
 * Reads the UTC creation time from an MP4/MOV `moov > mvhd` atom.
 *
 * The `mvhd` box stores creation time as seconds since 1904-01-01 UTC (32-bit
 * for version 0, 64-bit for version 1). Per the QuickTime/MP4 spec this value
 * is UTC with no timezone, so it is only used as a fallback when the Apple
 * local-time key is absent.
 */
function extractMvhdTime(view: DataView, moovStart: number, moovEnd: number): Date | null {
    const mvhd = findBox(view, "mvhd", moovStart, moovEnd);
    if (!mvhd) {
        return null;
    }

    // mvhd content: version(1) + flags(3) then creation_time.
    const version = view.getUint8(mvhd.start);
    let creationSeconds: number;
    if (version === 1) {
        const high = view.getUint32(mvhd.start + 4);
        const low = view.getUint32(mvhd.start + 8);
        creationSeconds = high * 2 ** 32 + low;
    } else {
        creationSeconds = view.getUint32(mvhd.start + 4);
    }

    if (!creationSeconds) {
        return null;
    }

    const unixMs = (creationSeconds - MP4_EPOCH_OFFSET_SECONDS) * 1000;
    const date = new Date(unixMs);
    return isNaN(date.getTime()) ? null : date;
}

/**
 * Extracts the creation time from a video container.
 *
 * exifr does not parse video containers, so we walk the ISO Base Media File
 * Format box structure directly. We prefer the Apple
 * `com.apple.quicktime.creationdate` key (local time, written by iOS and
 * recent Android camera apps) and fall back to the `mvhd` atom (UTC).
 */
function extractVideoTime(arrayBuffer: ArrayBuffer): Date | null {
    const view = new DataView(arrayBuffer);
    const moov = findBox(view, "moov", 0, view.byteLength);
    if (!moov) {
        return null;
    }

    return (
        extractQuickTimeCreationDate(view, moov.start, moov.end) ??
        extractMvhdTime(view, moov.start, moov.end)
    );
}

/**
 * Extracts the creation time-of-day ("HH:MM") from a media file's metadata.
 *
 * Categorization is based on the time of day the media was created, never the
 * calendar date. Images use EXIF (via exifr). Videos are parsed from the
 * MP4/MOV container, preferring the Apple `com.apple.quicktime.creationdate`
 * key (local time, written by iOS and recent Android) and falling back to the
 * `mvhd` atom (UTC). Returns null when no reliable creation timestamp is
 * available so the caller can fall back to a default section.
 */
export async function extractCreationTime(file: File): Promise<string | null> {
    try {
        const arrayBuffer = await file.arrayBuffer();

        let creationDate: Date | null = null;
        if (file.type.startsWith("video/")) {
            creationDate = extractVideoTime(arrayBuffer);
        } else if (file.type.startsWith("image/")) {
            creationDate = await extractImageTime(arrayBuffer);
        }

        return creationDate ? formatTimeOfDay(creationDate) : null;
    } catch (error) {
        console.error("Error extracting media creation time:", error);
        return null;
    }
}
