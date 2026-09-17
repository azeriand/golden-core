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
     * Intrinsic pixel dimensions of the media (image, or a video's poster),
     * persisted at upload time so the gallery layout can compute aspect ratios
     * before the media loads (no layout shift). null when unknown — legacy rows,
     * videos, or images whose preprocessing could not measure them; the client
     * then falls back to measuring on load.
     */
    width: number | null;
    height: number | null;
}
