"use client"
import HomeTopLayout from "../components/home-top-layout";
import Topbar from "../components/topbar";
import UserNavbar from "../components/user-navbar";
import SectionHeader from "../components/section-header";
import Masonry from "../components/masonry";
import useEventStore from "../src/stores/event.store";
import useGlobalStore from "../src/stores/global.store";
import useAuthStore from "../src/stores/auth.store";
import { Media } from "../dto/media";
import { useEffect, useState, useRef } from "react";
import { useParams } from 'next/navigation'
import ZoomPhoto from "../components/zoom-photo";

export default function Home() {

  const [zoomedPhoto, setZoomedPhoto] = useState<Media | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const headerRef = useRef<HTMLDivElement>(null);
  const { fetchEvent, event, loading } = useEventStore();
  const { state } = useGlobalStore();
  const { user } = useAuthStore();
  const params = useParams<{ id: string, ['event-slug']: string }>()
  const slug = params["event-slug"];

  useEffect(() => {
    fetchEvent(slug);
  }, [fetchEvent, slug]);

  useEffect(() => {
    if (!headerRef.current) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        setScrolled(!entry.isIntersecting);
      },
      {
        threshold: 0,
      }
    );

    observer.observe(headerRef.current);

    return () => {
      observer.disconnect();
    };
  }, [loading, event]);

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
    <main className="flex flex-col align-items-center w-full gap-y-4">
      {zoomedPhoto && ( 
        <ZoomPhoto src={zoomedPhoto.content} likes={zoomedPhoto.likes} mediaID={zoomedPhoto.media_id} liked={zoomedPhoto.liked} onClose={() => setZoomedPhoto(null)} />
      )}
      <div ref={headerRef}>
        <HomeTopLayout event_name={event.event_name} event_date={event.event_date} />
      </div>
      {scrolled && <Topbar event_name={event.event_name} />}
      {state !== "home" && <UserNavbar />}
      {filteredSections.map((section) => (
        <div key={section.section_id}>
          <SectionHeader label={section.section_name} time={`${section.start_date}-${section.finish_date}`} />
          <Masonry images={section.media} sections={event.sections} onZoom={(media) => setZoomedPhoto(media)} />
        </div>
      ))}
    </main>
  );

}
