"use client"
import HomeTopLayout from "../components/home-top-layout";
import UserNavbar from "../components/user-navbar";
import SectionHeader from "../components/section-header";
import Masonry from "../components/masonry";
import useEventStore from "../src/stores/event.store";
import useGlobalStore from "../src/stores/global.store";
import useAuthStore from "../src/stores/auth.store";
import { Media } from "../dto/media";
import { useEffect, useState } from "react";
import { useParams } from 'next/navigation'
import ZoomPhoto from "../components/zoom-photo";

export default function Home() {

  const [zoomedMedia, setZoomedMedia] = useState<Media | null>(null);
  const { fetchEvent, event, loading } = useEventStore();
  const { state } = useGlobalStore();
  const { user } = useAuthStore();
  const params = useParams<{ id: string, ['event-slug']: string }>()
  const slug = params["event-slug"];

  useEffect(() => {
    if (!user) return;

    fetchEvent(slug);
  }, [fetchEvent, slug, user]);

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



  if (loading) {
    return <span className="loader"></span>;
  }

  if (!event) {
    return <p>Event not found.</p>;
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
      <HomeTopLayout event_name={event.event_name} event_date={event.event_date} />
      {state !== "home" && <UserNavbar />}
      {filteredSections.map((section) => (
        <div key={section.section_id} className="pt-4 flex flex-col gap-y-2">
          <SectionHeader label={section.section_name} time={`${section.start_date}-${section.finish_date}`} />
          <Masonry images={section.media} sections={event.sections} onZoom={(media) => setZoomedMedia(media)} />
        </div>
      ))}
    </main>
  );

}
