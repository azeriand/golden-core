"use client"
import HomeTopLayout from "../components/home-top-layout";
import Topbar from "../components/topbar";
import UserNavbar from "../components/user-navbar";
import SectionHeader from "../components/section-header";
import Masonry from "../components/masonry";
import useEventStore from "../src/stores/event.store";
import { useEffect } from "react";
import { useParams } from 'next/navigation'

export default function Home() {

  const { fetchEvent, event, loading } = useEventStore();
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

  return (
    <main className="flex flex-col align-items-center w-full gap-y-4">
      <HomeTopLayout event_name={event.event_name} event_date={event.event_date} />
      <Topbar event_name={event.event_name}/>
      <UserNavbar />
      {event.sections.map((section) => (
        <div key={section.section_id}>
          <SectionHeader label={section.section_name} time={`${section.start_date}-${section.finish_date}`} />
          <Masonry images={section.media} />
        </div>
      ))}
    </main>
  );

}
