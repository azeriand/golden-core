"use client"
import { Button } from "azeriand-library"
import HomeTopLayout from "../components/home-top-layout";
import UserNavbar from "../components/user-navbar";
import SectionHeader from "../components/section-header";
import Masonry, { UploadPlaceholders } from "../components/masonry";
import RecoveryNoticePopup from "../components/recovery-notice-popup";
import useEventStore from "../src/stores/event.store";
import useGlobalStore from "../src/stores/global.store";
import useAuthStore from "../src/stores/auth.store";
import useUploadStore from "../src/stores/upload.store";
import { Media } from "../dto/media";
import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from 'next/navigation'
import ZoomPhoto from "../components/zoom-photo";

const DEMO_EMAIL = "demo@golden-core.app";

export default function Home() {

  const [zoomedMedia, setZoomedMedia] = useState<Media | null>(null);
  const { fetchEvent, event, loading } = useEventStore();
  const { state } = useGlobalStore();
  const { user, loading: authLoading, setUser } = useAuthStore();
  const params = useParams<{ id: string, ['event-slug']: string }>()
  const router = useRouter();
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

  // Tracks the slug whose event we've already loaded, so an unrelated `user`
  // reference change (e.g. the enqueue-time identity re-sync via loadUser) does
  // NOT retrigger fetchEvent — which would blank the whole gallery to the Loader
  // (event: null, loading: true) for a few seconds and wipe just-added upload
  // placeholders. See the coordinator effect for the exact fetch condition.
  const loadedSlugRef = useRef<string | null>(null);
  // Tracks the slug a fetchEvent is currently in flight for, so the coordinator
  // effect (which re-runs on user/event changes) never fires a second fetch for
  // the same slug while the first is still resolving.
  const fetchingSlugRef = useRef<string | null>(null);

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

      // CASE 3: correct session in place → fetch the event, but NOT on every
      // `user` reference change. The enqueue-time identity re-sync (loadUser)
      // produces a new `user` object; refetching then would set
      // event:null/loading:true and flash the Loader over the gallery, wiping
      // just-added upload placeholders. Fetch only once per slug: skip when we
      // have already fetched this slug (loadedSlugRef) or a fetch for it is
      // already in flight (fetchingSlugRef). A slug change resets both guards.
      if (
        !cancelled &&
        loadedSlugRef.current !== slug &&
        fetchingSlugRef.current !== slug
      ) {
        fetchingSlugRef.current = slug;
        fetchEvent(slug);
      }
    };

    resolvePage();

    return () => { cancelled = true; };
  }, [mounted, authLoading, slug, user, isDemoSlug, isDemoSession, fetchEvent, setUser]);

  // Remember which slug we've successfully loaded the event for, so the
  // coordinator effect above can skip refetching on unrelated `user` changes
  // (its guard compares loadedSlugRef against the current slug). Also clears the
  // in-flight marker once the event resolves.
  useEffect(() => {
    if (event) {
      // Loaded successfully for this slug.
      loadedSlugRef.current = slug;
      fetchingSlugRef.current = null;
    } else if (!loading && fetchingSlugRef.current === slug) {
      // A fetch for this slug settled with no event (not-found / error). Clear
      // the in-flight marker so a legitimate later trigger (e.g. after re-auth)
      // can retry, without blanking the gallery on unrelated user changes.
      fetchingSlugRef.current = null;
    }
  }, [event, loading, slug]);

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

  // Cross-reload upload recovery bootstrap (Task 9.4, design Component 7).
  // Once we are mounted on the client, have a resolved (non-demo) session, the
  // event slug, AND the event itself is loaded, surface/auto-resume any
  // interrupted uploads persisted in IndexedDB. Gating on `event` is important:
  // transparent auto-resume drives the recovered item through processOne, which
  // needs the numeric `event_id` (to build the Blob pathname and pass the
  // confirm/blob-belongs-to-event check). If recovery ran before the event
  // finished loading, a resumed image would immediately fail with "no event"
  // instead of resuming. `recoverInterrupted` is idempotent + run-once
  // (module-level guard), so this still runs at most once. Skipped for the demo
  // session/slug (demo is immutable and never produces recoverable uploads).
  useEffect(() => {
    if (!mounted) return;
    if (!slug) return;
    if (isDemoSlug || isDemoSession) return;
    if (!user) return;
    if (!event) return;
    void useUploadStore.getState().recoverInterrupted(slug);
  }, [mounted, slug, isDemoSlug, isDemoSession, user, event]);



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
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-y-2 px-6 text-center">
        <p className="text-7xl font-black text-purple-300">404</p>
        <h1 className="text-2xl font-bold text-purple-700">Ups... evento no encontrado</h1>
        <Button appearance='mate' color="purple" intensity={200} size='sm' className="mt-4 rounded-xl! border-purple-200!" style={{ color: '#9D7BD6' }} onClick={() => router.push('/demo')}>
          Ir a la demo
        </Button>
      </div>
    );
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
      {/* One-time Spanish notice: videos / oversized images can't auto-resume
          after a reload and must be re-uploaded manually. Shows only when the
          recovery pass surfaced such items. */}
      <RecoveryNoticePopup />
      {zoomedMedia && ( 
        <ZoomPhoto src={zoomedMedia.content} likes={zoomedMedia.likes} mediaID={zoomedMedia.media_id} liked={zoomedMedia.liked} type={zoomedMedia.type} eventSlug={slug} onClose={() => setZoomedMedia(null)} />
      )}
      <HomeTopLayout event_name={event.event_name} event_date={event.event_date} visibleMediaIds={filteredSections.flatMap((s) => s.media.map((m) => m.media_id))} />
      {state !== "home" && <UserNavbar />}
      {/* Global upload placeholders: rendered ONCE here so they appear INSTANTLY
          on enqueue, regardless of whether any section currently has media in
          the active view (previously placeholders only lived inside a per-section
          Masonry, so an empty/filtered section left them with nowhere to show
          until an upload completed). Returns null when idle. Per-section Masonry
          instances below pass showPlaceholders={false} to avoid duplication. */}
      <UploadPlaceholders />
      {filteredSections.map((section) => (
        <div key={section.section_id} className="pt-4 flex flex-col gap-y-2 w-full">
          <SectionHeader label={section.section_name} time={`${section.start_date}-${section.finish_date}`} />
          <Masonry images={section.media} sections={event.sections} onZoom={(media) => setZoomedMedia(media)} showPlaceholders={false} />
        </div>
      ))}
    </main>
  );

}
