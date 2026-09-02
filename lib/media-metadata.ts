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

/**
 * Reads the creation time from an MP4/MOV `moov > mvhd` atom.
 *
 * exifr does not parse video containers, so we walk the ISO Base Media File
 * Format box structure directly. The `mvhd` box stores the creation time as
 * seconds since 1904-01-01 UTC (32-bit for version 0, 64-bit for version 1).
 *
 * Note: the stored value is read back as-is via the UTC getters. In practice
 * most phone cameras write the local wall-clock time into `mvhd`, which lines
 * up with how section time windows are configured for an event. Only the
 * top-level boxes and the `moov` children are scanned, which is cheap and
 * avoids reading media sample data.
 */
function extractVideoTime(arrayBuffer: ArrayBuffer): Date | null {
    const view = new DataView(arrayBuffer);
    const total = view.byteLength;

    // Locates a child box by type within [start, end); returns its content range.
    function findBox(type: string, start: number, end: number): { start: number; end: number } | null {
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
                // Box extends to the end of the file.
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

    const moov = findBox("moov", 0, total);
    if (!moov) {
        return null;
    }

    const mvhd = findBox("mvhd", moov.start, moov.end);
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
 * Extracts the creation time-of-day ("HH:MM") from a media file's metadata.
 *
 * Categorization is based on the time of day the media was created, never the
 * calendar date. Images use EXIF (via exifr); videos are parsed from the
 * MP4/MOV container's `mvhd` atom. Returns null when no reliable creation
 * timestamp is available so the caller can fall back to a default section.
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
