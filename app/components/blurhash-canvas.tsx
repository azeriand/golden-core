"use client";

import { useEffect, useRef } from "react";
import { decode } from "blurhash";

interface BlurhashCanvasProps {
    blurhash: string;
    width?: number;
    height?: number;
    className?: string;
    onDecodeError?: () => void;
}

export default function BlurhashCanvas({ blurhash, width = 32, height = 32, className, onDecodeError }: BlurhashCanvasProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        try {
            const pixels = decode(blurhash, width, height);
            const ctx = canvas.getContext("2d");
            if (!ctx) return;

            const imageData = ctx.createImageData(width, height);
            imageData.data.set(pixels);
            ctx.putImageData(imageData, 0, 0);
        } catch (error) {
            console.error("Error decoding blurhash:", error);
            onDecodeError?.();
        }
    }, [blurhash, width, height, onDecodeError]);

    return (
        <canvas
            ref={canvasRef}
            width={width}
            height={height}
            className={className}
        />
    );
}
