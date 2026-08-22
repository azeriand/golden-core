import { encode } from "blurhash";
import sharp from "sharp";

/**
 * Generates a blurhash string from an image buffer.
 * Resizes the image to a small dimension for fast encoding.
 */
export async function generateBlurhash(buffer: ArrayBuffer): Promise<string | null> {
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
