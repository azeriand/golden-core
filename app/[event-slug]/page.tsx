"use client"
import HomeTopLayout from "../components/home-top-layout";
import UserNavbar from "../components/user-navbar";
import SectionHeader from "../components/section-header";
import Masonry from "../components/masonry";
import useEventStore from "../src/stores/event.store";
import useGlobalStore from "../src/stores/global.store";
import useAuthStore from "../src/stores/auth.store";
import { Media } from "../dto/media";
import { useEffect, useRef, useState } from "react";
import { useParams } from 'next/navigation'
import ZoomPhoto from "../components/zoom-photo";

const DEMO_EMAIL = "demo@golden-core.app";

export default function Home() {

  const [zoomedMedia, setZoomedMedia] = useState<Media | null>(null);
  const { fetchEvent, event, loading } = useEventStore();
  const { state } = useGlobalStore();
  const { user, loading: authLoading, setUser } = useAuthStore();
  const params = useParams<{ id: string, ['event-slug']: string }>()
  const slug = params["event-slug"];

  // Hydration guard: the very first client render must match the SSR output,
  // so the loader is rendered until the component is mounted on the client.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const isDemoSlug = slug === "demo";
  const isDemoSession = user?.email === DEMO_EMAIL;

  // Ref lock: guards against duplicate demo auto-login requests (React Strict
  // Mode mounts effects twice in development, and re-renders could otherwise
  // fire a second POST before the session is replaced).
  const demoAuthLock = useRef(false);

  // Single coordinator effect: resolves auth + demo session + event loading in order.
  useEffect(() => {
    if (!mounted) return;
    if (authLoading) return;

    let cancelled = false;

    const resolvePage = async () => {
      // CASE 1: /demo but not yet the Demo session (no user OR a normal user).
      // Replace the session with the Demo session BEFORE fetching the event.
      if (isDemoSlug && !isDemoSession) {
        if (demoAuthLock.current) return;
        demoAuthLock.current = true;
        try {
          const res = await fetch("/api/demo/auth", { method: "POST" });
          if (res.ok) {
            const demoUser = await res.json();
            // Set the store directly from the response — avoids a follow-up
            // GET /api/me that could race the freshly written cookie.
            setUser(demoUser); // updates user → re-runs this effect as Demo
          } else {
            console.error("Demo auto-login failed with status", res.status);
          }
        } catch (error) {
          console.error("Demo auto-login failed:", error);
        } finally {
          demoAuthLock.current = false;
        }
        return;
      }

      // CASE 2: normal slug with no session → do nothing (layout shows AuthPopup).
      if (!user) return;

      // CASE 3: correct session in place → fetch the event.
      if (!cancelled) {
        fetchEvent(slug);
      }
    };

    resolvePage();

    return () => { cancelled = true; };
  }, [mounted, authLoading, slug, user, isDemoSlug, isDemoSession, fetchEvent, setUser]);

  // Handle visibility change to prevent iOS freeze when returning from lock screen.
  // iOS pauses JS and compositing when the phone is locked. On resume, backdrop-filter
  // elements and stale IntersectionObserver callbacks can deadlock the compositor.
  // We force a layout recalculation on resume to kick the rendering pipeline back to life.
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        // Force a style recalculation to unfreeze iOS compositor
        document.body.style.opacity = "0.999";
        requestAnimationFrame(() => {
          document.body.style.opacity = "1";
        });
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);



  const Loader = (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-[#FFFCF8]">
      <div
        className="animate-spin rounded-full"
        style={{
          width: '48px',
          height: '48px',
          border: '4px solid #E3D1F4',
          borderTopColor: '#9D7BD6',
        }}
      />
    </div>
  );

  // Until mounted, always render the loader so SSR and first client render match.
  if (!mounted) return Loader;

  // Auth still resolving.
  if (authLoading) return Loader;

  // /demo but not yet the Demo session: auto-login in progress.
  if (isDemoSlug && !isDemoSession) return Loader;

  // Normal slug with no session: render nothing so the layout's AuthPopup shows.
  if (!user) return null;

  // We have the correct session; event is being fetched.
  if (loading) return Loader;

  // Fetch finished and there is no event: genuinely not found.
  if (!event) {
    return <p>Evento no encontrado.</p>;
  }


  const filteredSections = event.sections.map((section) => ({
    ...section, media: section.media.filter((media) => {
      if (state === 'home') return true;
      if (state === 'myPhotos') return media.user_id === user?.id;
      if (state === 'favPhotos') return media.liked;
      return true;
    }),
  })).filter((section) => section.media.length > 0);

  return (
    <main className="flex flex-col items-center w-full gap-y-4">
      {zoomedMedia && ( 
        <ZoomPhoto src={zoomedMedia.content} likes={zoomedMedia.likes} mediaID={zoomedMedia.media_id} liked={zoomedMedia.liked} type={zoomedMedia.type} eventSlug={slug} onClose={() => setZoomedMedia(null)} />
      )}
      <HomeTopLayout event_name={event.event_name} event_date={event.event_date} visibleMediaIds={filteredSections.flatMap((s) => s.media.map((m) => m.media_id))} />
      {state !== "home" && <UserNavbar />}
      {filteredSections.map((section) => (
        <div key={section.section_id} className="pt-4 flex flex-col gap-y-2 w-full">
          <SectionHeader label={section.section_name} time={`${section.start_date}-${section.finish_date}`} />
          <Masonry images={section.media} sections={event.sections} onZoom={(media) => setZoomedMedia(media)} />
        </div>
      ))}
    </main>
  );

}
