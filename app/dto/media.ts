export interface Media {
    media_id: number;
    user_id: number;
    content: string;
    type: string | null;
    likes: number;
    liked: boolean;
    date: string;
    section_id: number | null;
    blurhash: string | null;
    username: string | null;
    poster_url: string | null;
    /**
     * The preserved, untouched ORIGINAL Blob URL (media-transcoding). `content`
     * is what the app serves (the reduced display derivative once the worker has
     * produced it, or the original until then); `original_url` always points at
     * the full-quality original for future high-quality delivery (e.g.
     * WeTransfer export) and downloads. null on legacy rows uploaded before this
     * feature, where `content` is the only version.
     */
    original_url: string | null;
    /**
     * Intrinsic pixel dimensions of the media (image, or a video's poster),
     * persisted at upload time so the gallery layout can compute aspect ratios
     * before the media loads (no layout shift). null when unknown — legacy rows,
     * videos, or images whose preprocessing could not measure them; the client
     * then falls back to measuring on load.
     */
    width: number | null;
    height: number | null;
    /**
     * Whether this media item is hidden from public view. Only present in admin
     * responses; undefined in public responses (Req 3.5). Populated from the
     * event API when the requesting user has isAdmin = true.
     */
    is_hidden?: boolean;
}
