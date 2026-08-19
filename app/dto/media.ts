export interface Media {
    media_id: number;
    user_id: number;
    content: string;
    type: string | null;
    likes: number;
    liked: boolean;
    date: string;
    section_id: number | null;
}