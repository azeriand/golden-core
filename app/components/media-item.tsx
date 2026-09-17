"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import LikeCounter from "./like-counter";
import BlurhashCanvas from "./blurhash-canvas";
import { Section } from "../dto/section";
import useMediaUiStore from "../src/stores/media-ui.store";
import { MdOutlineRadioButtonUnchecked } from "react-icons/md";
import { MdOutlineCheckCircleOutline } from "react-icons/md";

// How long we wait for a poster image to paint before falling back to the
// placeholder. Req 12.5: "IF a poster ... does not load within a configured
// timeout, THEN THE Gallery SHALL display the placeholder so every video slot
// shows a visible element." Kept as a module constant so the value is a single
// source of truth (and easy to tune) rather than a magic number inline.
const POSTER_LOAD_TIMEOUT_MS = 8000;

export default function MediaItem({index, src, type, poster_url, likes, liked, mediaID, section_id, sections, blurhash, username, onZoom}: {index: number, src: string, type: string | null, poster_url?: string | null, likes: number, liked: boolean, mediaID: number, section_id: number|null, sections: Section[], blurhash: string | null, username: string | null, onZoom: () => void}) {
    const [loaded, setLoaded] = useState(false);
    const [errored, setErrored] = useState(false);
    const [blurhashFailed, setBlurhashFailed] = useState(false);
    // Whether the video poster failed to load or timed out. When true we fall
    // back to the placeholder even though a poster_url was provided, so every
    // video slot always shows a visible element (Req 12.5).
    const [posterFailed, setPosterFailed] = useState(false);
    // Kept mounted until the image's opacity fade-in completes, so the placeholder
    // stays visible BEHIND the image through the 300ms transition (no flash of the
    // article background). Once the opaque image fully covers it, we unmount it.
    const [fadeComplete, setFadeComplete] = useState(false);

    // Stable identity so BlurhashCanvas's decode effect deps stay [blurhash, width, height, onDecodeError]
    // and it does not re-decode on unrelated re-renders.
    const handleBlurhashDecodeError = useCallback(() => setBlurhashFailed(true), []);

    const isVideo = type?.startsWith("video/");

    // A poster is renderable only when a non-null URL was provided AND it has
    // not failed/timed out. When false we render the placeholder + play overlay
    // instead, while the <video> itself still plays when opened (Req 15.1).
    const hasPoster = isVideo && !!poster_url && !posterFailed;

    // Timeout guard for poster loading (Req 12.5). While a poster_url is present
    // but has not yet loaded, arm a timer; if the poster does not paint in time
    // we flip to the placeholder. The timer is cleared on a successful poster
    // load (below, via the poster <img>'s onLoad) and on unmount, so a poster
    // that loads in time never trips the fallback.
    const posterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => {
        // Only guard while we actually have a poster to wait for and it has not
        // yet loaded or failed. Re-runs whenever these inputs change.
        if (!isVideo || !poster_url || loaded || posterFailed) return;
        posterTimerRef.current = setTimeout(() => setPosterFailed(true), POSTER_LOAD_TIMEOUT_MS);
        return () => {
            if (posterTimerRef.current) clearTimeout(posterTimerRef.current);
        };
    }, [isVideo, poster_url, loaded, posterFailed]);

    // On a successful poster paint (the poster <img>'s onLoad): clear the
    // timeout guard and mark loaded so the fallback can never fire afterwards.
    const handlePosterLoaded = useCallback(() => {
        if (posterTimerRef.current) clearTimeout(posterTimerRef.current);
        setLoaded(true);
    }, []);

    // A poster that fails to load falls back to the placeholder (Req 12.5).
    const handlePosterError = useCallback(() => setPosterFailed(true), []);

    // Reserve layout height per cell until the media loads. Without this, the
    // Next.js <Image> renders with width/height 0 (h-auto) and the blurhash
    // canvas is absolutely positioned, so each masonry cell collapses to ~0px.
    // The browser then sees every cell stacked inside the viewport and fires all
    // `loading="lazy"` requests at once. A fallback aspect-ratio gives each cell
    // real height so lazy loading can correctly defer off-screen media; once the
    // real media loads, h-auto restores its true aspect ratio.
    const FALLBACK_ASPECT_RATIO = "3 / 4";
    const reserveSpace = !loaded && !errored;
    const placeholderStyle = reserveSpace ? { aspectRatio: FALLBACK_ASPECT_RATIO } : undefined;

    const { isSelectionMode, selectedIds, toggleSelected } = useMediaUiStore();

    const selected = selectedIds.has(mediaID);

    const handleClick = () => {
        if (isSelectionMode) {
            toggleSelected(mediaID);
            return;
        }

        onZoom();
    };

    return(
        <article key={index} style={placeholderStyle} className='w-full h-auto relative overflow-hidden'>

            {selected && (
                <div className="absolute inset-0 z-5 bg-white/30 pointer-events-none transition-opacity duration-200" />
            )}

            { isSelectionMode && (
                <div className="absolute top-2 right-2 z-10 w-7 h-7 rounded-full bg-white/20 backdrop-blur-md border border-white/30 text-white flex items-center justify-center cursor-pointer" onClick={() => toggleSelected(mediaID)}>
                    {selected ? <MdOutlineCheckCircleOutline size={20}/> : <MdOutlineRadioButtonUnchecked size={20}/>}
                </div>
            )}

            {isVideo ? (
                <div className="relative cursor-pointer" style={hasPoster ? undefined : placeholderStyle} onClick={handleClick}>
                    {hasPoster ? (
                        // Poster ready: render the generated poster frame as a real
                        // <img> (via next/image), NOT the <video>'s `poster`
                        // attribute. A <video preload="none"> never fires
                        // `loadedData` because the browser fetches no video bytes,
                        // so relying on it left `loaded` false and the timeout guard
                        // below always tripped the placeholder — hiding a poster that
                        // had actually painted. An <img> fires onLoad/onError
                        // reliably on every browser (incl. iOS Safari), renders the
                        // same consistent frame (Req 12.2, 12.3), and downloads the
                        // poster exactly once. The <video> itself is only loaded when
                        // the user opens the zoom viewer to play it (Req 15.1), so no
                        // video bytes are fetched in the gallery.
                        <Image
                            data-testid="poster-video"
                            src={poster_url as string}
                            alt={`Vídeo ${index}`}
                            width={0}
                            height={0}
                            sizes="50vw"
                            onLoad={handlePosterLoaded}
                            onError={handlePosterError}
                            className="w-full h-auto pointer-events-none transition-all duration-200"
                        />
                    ) : (
                        // No poster yet (poster_url is null) OR the poster failed /
                        // timed out: reserve layout space with a placeholder so the
                        // slot is a visible element and the gallery stays consistent
                        // without blocking on poster availability (Req 12.1, 12.4,
                        // 12.5). The video still plays when opened (Req 15.1).
                        <div data-testid="poster-placeholder" className="w-full h-full bg-black/10" style={{ aspectRatio: FALLBACK_ASPECT_RATIO }} />
                    )}
                    <div data-testid="play-overlay" className="absolute inset-0 flex items-center justify-center">
                        <div className="w-10 h-10 rounded-full bg-white/20 backdrop-blur-md border border-white/30 flex items-center justify-center">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="white"><polygon points="5,3 19,12 5,21" /></svg>
                        </div>
                    </div>
                </div>
            ) : (
                <>
                    {blurhash && !fadeComplete && !errored && !blurhashFailed && (
                        <BlurhashCanvas
                            blurhash={blurhash}
                            width={32}
                            height={32}
                            className="w-full h-auto absolute inset-0 object-cover"
                            onDecodeError={handleBlurhashDecodeError}
                        />
                    )}
                    <Image
                        src={src}
                        alt={`Imagen ${index}`}
                        width={0}
                        height={0}
                        sizes="50vw"
                        className={`w-full cursor-pointer transition-opacity duration-300 ${loaded ? 'opacity-100' : 'opacity-0'} ${reserveSpace ? 'absolute inset-0 h-full object-cover' : 'h-auto'}`}
                        style={reserveSpace ? undefined : { width: '100%', height: 'auto' }}
                        onLoad={() => setLoaded(true)}
                        onError={() => setErrored(true)}
                        onTransitionEnd={() => { if (loaded) setFadeComplete(true); }}
                        onClick={handleClick}
                        loading="lazy"
                    />
                </>
            )}
            <div className="absolute bottom-2 left-2 right-2 flex justify-between items-center">
                {username && <span className="text-xs text-white/80 drop-shadow-md">{username}</span>}
                <LikeCounter likes={likes} mediaID={mediaID} liked={liked} className='ml-auto'/>
            </div>
        </article>
    )
}
