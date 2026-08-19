//Download selected media

import { NextRequest } from "next/server";
import jwt from "jsonwebtoken";
import pool from "@/lib/db";
import { ZipArchive } from "archiver";

export async function POST(request: NextRequest, { params }: { params: Promise<{ "event-slug": string }> }) {

    const { "event-slug": eventSlug } = await params;
 
    const token = request.cookies.get("auth_token")?.value;

    if (!token) {
        return new Response("Unauthorized", {
        status: 401,
        });
    } 

    const jwtSecret = process.env.JWT_SECRET;

    if (!jwtSecret) {
        return new Response("JWT_SECRET is not configured", {
            status: 500,
        });
    }

    let decoded: any;

    try {
        decoded = jwt.verify(token, jwtSecret) as any;
    } catch {
        return new Response("Unauthorized", {
            status: 401,
        });
    }

    const userId = decoded.userId;

    if (!userId) {
        return new Response("Unauthorized", {
        status: 401,
        });
    }

    try{
        const body = await request.json();

        const mediaIds = body.mediaIds;

        if (!Array.isArray(mediaIds) || mediaIds.length === 0) {
            return new Response("No media selected", {
                status: 400,
            });
        }

        const mediaResult = await pool.query(
            `SELECT
                media_id,
                content,
                type
            FROM media
            WHERE media_id = ANY($1::int[])
            AND event_id = (
                SELECT event_id
                FROM events
                WHERE event_slug = $2
            )`, [mediaIds, eventSlug]);

        if (mediaResult.rows.length !== mediaIds.length) {
            return new Response(
                "One or more media files were not found",
                { status: 404 }
            );
        }

        const files = await Promise.all(
            mediaResult.rows.map(async (media) => {
                const response = await fetch(media.content);

                if (!response.ok) {
                    throw new Error(
                        `Failed to download media ${media.media_id}`
                    );
                }

                const buffer = await response.arrayBuffer();

                const type = media.type || response.headers.get("content-type") || "application/octet-stream";

                return {
                    media_id: media.media_id,
                    type,
                    buffer,
                };
            })
        );

    const archive = new ZipArchive({
        zlib: { level: 9 },
    });

    const readableStream = new ReadableStream({
        start(controller) {
            archive.on("data", (chunk: Buffer) => {
                controller.enqueue(new Uint8Array(chunk));
            });

            archive.on("end", () => {
                controller.close();
            });

            archive.on("error", (error) => {
                console.error("ZIP ERROR:", error);
                controller.error(error);
            });

            for (const file of files) {

                console.log("FILE BEFORE ZIP:", {
                    media_id: file.media_id,
                    type: file.type,
                });
                const extension = file.type.split("/")[1] || "bin";

                archive.append(Buffer.from(file.buffer), {
                    name: `media-${file.media_id}.${extension}`,
                });
            }

            archive.finalize();
        },
    });

        return new Response(readableStream, {
            status: 200,
            headers: {
                "Content-Type": "application/zip",
                "Content-Disposition": 'attachment; filename="media.zip"',
            },
        });

    }catch (error) {
        console.error("DOWNLOAD API ERROR:", error);

        return new Response(
            error instanceof Error ? error.message : String(error),
            {
                status: 500,
            }
        );
    }


}

