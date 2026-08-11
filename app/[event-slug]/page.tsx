"use client"
import HomeTopLayout from "../components/home-top-layout";
import Topbar from "../components/topbar";
import UserNavbar from "../components/user-navbar";
import SectionHeader from "../components/section-header";
import Masonry from "../components/masonry";
import useEventStore from "../src/stores/event.store";
import useGlobalStore from "../src/stores/global.store";
import useAuthStore from "../src/stores/auth.store";
import { useEffect } from "react";
import { useParams } from 'next/navigation'

export default function Home() {

  const { fetchEvent, event, loading } = useEventStore();
  const { state } = useGlobalStore();
  const { user } = useAuthStore();
  const params = useParams<{ id: string, ['event-slug']: string }>()
  const slug = params["event-slug"];

  useEffect(() => {
    fetchEvent(slug);
  }, [fetchEvent, slug]);

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
      <HomeTopLayout event_name={event.event_name} event_date={event.event_date} />
      <Topbar event_name={event.event_name}/>
      {state !== "home" && <UserNavbar />}
      {filteredSections.map((section) => (
        <div key={section.section_id}>
          <SectionHeader label={section.section_name} time={`${section.start_date}-${section.finish_date}`} />
          <Masonry images={section.media} />
        </div>
      ))}
    </main>
  );

}
