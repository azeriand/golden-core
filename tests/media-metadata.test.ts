import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { extractCreationTime } from "@/lib/media-metadata";

// Real HEIC exported from the app, kept as a fixture. Its EXIF DateTimeOriginal
// is "2026:09:03 20:39:40" with OffsetTimeOriginal "+02:00", so the correct
// local capture time-of-day is 20:39. The result must be identical regardless
// of the server timezone.
const FIXTURE = path.join(__dirname, "fixtures", "IMG_3601.HEIC");

function fileFromDisk(diskPath: string, name: string, type: string): File {
    const buf = readFileSync(diskPath);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    return new File([ab], name, { type });
}

describe("extractCreationTime — image EXIF (timezone independence)", () => {
    it("returns the local wall-clock capture time from HEIC EXIF", async () => {
        const file = fileFromDisk(FIXTURE, "IMG_3601.HEIC", "image/heic");
        const time = await extractCreationTime(file);
        expect(time).toBe("20:39");
    });

    it("does not depend on the server timezone", async () => {
        const original = process.env.TZ;
        try {
            for (const tz of ["UTC", "America/Los_Angeles", "Asia/Tokyo", "Europe/Madrid"]) {
                process.env.TZ = tz;
                const file = fileFromDisk(FIXTURE, "IMG_3601.HEIC", "image/heic");
                const time = await extractCreationTime(file);
                expect(time, `timezone ${tz}`).toBe("20:39");
            }
        } finally {
            process.env.TZ = original;
        }
    });

    it("detects HEIC as an image even when the browser omits the MIME type", async () => {
        const file = fileFromDisk(FIXTURE, "IMG_3601.HEIC", "");
        const time = await extractCreationTime(file);
        expect(time).toBe("20:39");
    });
});
