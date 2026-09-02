// Upload media files for a specific event

import pool from '@/lib/db';
import { NextRequest } from 'next/server';
import jwt from 'jsonwebtoken';
import { cookies } from 'next/headers';
import { put } from "@vercel/blob";
import { generateBlurhash } from '@/lib/blurhash';
import { extractCreationTime } from '@/lib/media-metadata';

import { isDemoEvent, demoGuardResponse } from '@/lib/demo-guard';

export const maxDuration = 60;

const VIDEO_EXTENSIONS = new Set(['mov', 'mp4', 'webm', '3gp', '3gpp', 'avi', 'mkv', 'm4v']);
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'gif', 'bmp', 'tiff']);
const ALL_MEDIA_EXTENSIONS = new Set([...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS]);

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

const MIME_FROM_EXTENSION: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
    gif: 'image/gif', bmp: 'image/bmp', tiff: 'image/tiff',
    mov: 'video/quicktime', mp4: 'video/mp4', m4v: 'video/mp4',
    webm: 'video/webm', avi: 'video/x-msvideo',
    '3gp': 'video/3gpp', '3gpp': 'video/3gpp', mkv: 'video/x-matroska',
};

/**
 * Validates image magic bytes to prevent disguised files (XSS via renamed HTML/SVG).
 * Only used for images — videos have too many container variations.
 */
function validateImageMagicBytes(header: Uint8Array): boolean {
    if (header[0] === 0xFF && header[1] === 0xD8 && header[2] === 0xFF) return true; // JPEG
    if (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4E && header[3] === 0x47) return true; // PNG
    if (header[0] === 0x47 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x38) return true; // GIF
    if (header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46 &&
        header[8] === 0x57 && header[9] === 0x45 && header[10] === 0x42 && header[11] === 0x50) return true; // WebP
    if (header[0] === 0x42 && header[1] === 0x4D) return true; // BMP
    if ((header[0] === 0x49 && header[1] === 0x49) || (header[0] === 0x4D && header[1] === 0x4D)) return true; // TIFF
    if (header[4] === 0x66 && header[5] === 0x74 && header[6] === 0x79 && header[7] === 0x70) return true; // HEIC/HEIF (ftyp)
    return false;
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ "event-slug": string }> }) {
    const { "event-slug": eventSlug } = await params;
    if (isDemoEvent(eventSlug)) return demoGuardResponse();
    const cookieStore = await cookies();
    const token = cookieStore.get('auth_token')?.value;

    // Parse form data
    let formData: FormData;
    try {
        formData = await request.formData();
    } catch (error) {
        return new Response("Error parsing form data", { status: 400 });
    }

    const file = formData.get("file");
    const date = formData.get("date") as string;

    if (!(file instanceof File)) {
        return new Response("File missing", { status: 400 });
    }

    if (!date) {
        return new Response("Date missing", { status: 400 });
    }

    if (!token) {
        return new Response("Unauthorized", { status: 401 });
    }

    // Authenticate
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
        return new Response("JWT_SECRET is not configured", { status: 500 });
    }

    let decoded: any;
    try {
        decoded = jwt.verify(token, jwtSecret) as any;
    } catch {
        return new Response("Unauthorized", { status: 401 });
    }

    const userId = decoded.userId;

    // Determine file type
    const fileExtension = file.name.split('.').pop()?.toLowerCase() || '';
    const isVideo = VIDEO_EXTENSIONS.has(fileExtension) || file.type.startsWith("video/");
    const isImage = !isVideo && (IMAGE_EXTENSIONS.has(fileExtension) || file.type.startsWith("image/"));

    // Validate: must be a known media file by MIME or extension
    const isAccepted = file.type.startsWith("image/") || file.type.startsWith("video/") || ALL_MEDIA_EXTENSIONS.has(fileExtension);
    if (!isAccepted) {
        return new Response(`Unsupported file: ${file.name}. Only images and videos are accepted.`, { status: 400 });
    }

    // Validate magic bytes for images to prevent XSS via disguised files
    if (isImage) {
        const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
        if (!validateImageMagicBytes(header)) {
            return new Response("File content does not match a supported image format", { status: 400 });
        }
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
        return new Response("File size exceeds 100 MB limit", { status: 400 });
    }

    // Extract creation time-of-day for automatic categorization.
    // Applies to both images and videos; categorization is based on the
    // creation time (never the date). Best-effort: null falls back to the
    // "Sin clasificar" section.
    const photoTime: string | null = await extractCreationTime(file);

    // Generate a blurhash preview for images only.
    let blurhash: string | null = null;
    if (isImage) {
        const arrayBuffer = await file.arrayBuffer();
        blurhash = await generateBlurhash(arrayBuffer);
    }

    // Find event
    const eventResult = await pool.query(
        `SELECT event_id FROM events WHERE event_slug = $1`,
        [eventSlug]
    );

    if (eventResult.rows.length === 0) {
        return new Response("Event not found", { status: 404 });
    }

    const eventId = eventResult.rows[0].event_id;

    // Determine section based on photo time
    let sectionId: number;
    try {
        if (photoTime) {
            const sectionResult = await pool.query(
                `SELECT section_id FROM sections
                 WHERE event_id = $1 AND section_name <> 'Sin clasificar'
                 AND start_date::time <= $2::time AND finish_date::time >= $2::time
                 LIMIT 1`,
                [eventId, photoTime]
            );

            if (sectionResult.rows.length > 0) {
                sectionId = sectionResult.rows[0].section_id;
            } else {
                const fallback = await pool.query(
                    `SELECT section_id FROM sections WHERE event_id = $1 AND section_name = 'Sin clasificar' LIMIT 1`,
                    [eventId]
                );
                if (fallback.rows.length === 0) return new Response("Default section not found", { status: 500 });
                sectionId = fallback.rows[0].section_id;
            }
        } else {
            const fallback = await pool.query(
                `SELECT section_id FROM sections WHERE event_id = $1 AND section_name = 'Sin clasificar' LIMIT 1`,
                [eventId]
            );
            if (fallback.rows.length === 0) return new Response("Default section not found", { status: 500 });
            sectionId = fallback.rows[0].section_id;
        }
    } catch (error) {
        console.error("Error finding section:", error);
        return new Response("Error finding section", { status: 500 });
    }

    // Infer MIME type if browser didn't provide a useful one
    let mediaType = file.type;
    if (!mediaType || mediaType === 'application/octet-stream') {
        mediaType = MIME_FROM_EXTENSION[fileExtension] || (isVideo ? 'video/mp4' : 'image/jpeg');
    }

    // Upload to Vercel Blob
    try {
        const blob = await put(file.name, file, {
            access: "public",
            contentType: mediaType,
        });

        const result = await pool.query(
            `INSERT INTO media (content, type, date, user_id, section_id, event_id, blurhash)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [blob.url, mediaType, date, userId, sectionId, eventId, blurhash]
        );

        return new Response(JSON.stringify(result.rows[0]), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (error) {
        console.error("Error uploading media:", error);
        return new Response("Error uploading media", { status: 500 });
    }
}
