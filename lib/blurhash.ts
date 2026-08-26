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
