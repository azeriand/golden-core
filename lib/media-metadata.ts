import exifr from "exifr";

export async function extractMediaDate(file: File): Promise<Date | null> {

    try {
        const arrayBuffer = await file.arrayBuffer();

        const metadata = await exifr.parse(arrayBuffer, {
            translateValues: true,
        });

        if (!metadata) {
            return null;
        }

        // Images
        if (file.type.startsWith("image/")) {
            return (
                metadata.DateTimeOriginal ??
                metadata.CreateDate ??
                metadata.ModifyDate ??
                null
            );
        }

        // Videos
        if (file.type.startsWith("video/")) {
            return (
                metadata.creation_time ??
                metadata.creationDate ??
                metadata.CreateDate ??
                metadata.ModifyDate ??
                null
            );
        }

        return null;
        
    } catch (error) {
        console.error("Error extracting media metadata:", error);
        return null;
    }
}