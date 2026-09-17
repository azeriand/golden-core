import { encode } from "blurhash";

/**
 * Generates a blurhash string from an image buffer.
 * Uses sharp to resize and extract raw pixels.
 * Returns null gracefully if sharp is unavailable.
 */
export async function generateBlurhash(buffer: ArrayBuffer): Promise<string | null> {
    let sharp: any;
    try {
        sharp = (await import("sharp")).default;
    } catch {
        console.warn("Sharp not available, skipping blurhash generation");
        return null;
    }

    try {
        const { data, info } = await sharp(Buffer.from(buffer))
            .resize(32, 32, { fit: "inside" })
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });

        const blurhash = encode(
            new Uint8ClampedArray(data),
            info.width,
            info.height,
            4, // x components
            3  // y components
        );

        return blurhash;
    } catch (error) {
        console.error("Error generating blurhash:", error);
        return null;
    }
}

/**
 * Reads the intrinsic pixel dimensions of an image buffer using sharp, honoring
 * the EXIF orientation so the returned width/height match how the image is
 * actually displayed (a portrait shot tagged as rotated reports portrait dims).
 * Returns { width: null, height: null } gracefully if sharp is unavailable or
 * the metadata cannot be read — dimensions are optional (the client falls back
 * to measuring on load), so this never throws.
 */
export async function getImageDimensions(
    buffer: ArrayBuffer,
): Promise<{ width: number | null; height: number | null }> {
    let sharp: typeof import("sharp").default;
    try {
        sharp = (await import("sharp")).default;
    } catch {
        console.warn("Sharp not available, skipping dimension extraction");
        return { width: null, height: null };
    }

    try {
        const meta = await sharp(Buffer.from(buffer)).metadata();
        // EXIF orientation 5-8 swap width/height when the image is displayed.
        const swap = typeof meta.orientation === "number" && meta.orientation >= 5;
        const w = swap ? meta.height : meta.width;
        const h = swap ? meta.width : meta.height;
        return {
            width: typeof w === "number" && w > 0 ? w : null,
            height: typeof h === "number" && h > 0 ? h : null,
        };
    } catch (error) {
        console.error("Error reading image dimensions:", error);
        return { width: null, height: null };
    }
}
