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

  const { fetchEvent, event_name, event_date, sections } = useEventStore();
  const params = useParams<{ id: string, ['event-slug']: string }>()

  useEffect(() => {
    fetchEvent(params['event-slug']);
  } , []);

  const images = [
    'https://picsum.photos/id/1/200/300',
    'https://picsum.photos/id/2/100/400',
    'https://picsum.photos/id/3/550/100',
    'https://picsum.photos/id/4/40/150',
    'https://picsum.photos/id/5/400/100',
    'https://picsum.photos/id/6/550/200',
  ];

  return (
    <main className="flex flex-col align-items-center w-full gap-y-4">
      {
        event_name !== "" && (
          <>
            <HomeTopLayout event_name={event_name} event_date={event_date} />
            <Topbar event_name={event_name}/>
            <UserNavbar />
            {sections.map((section) => (
              <div key={section.section_id}>
                <SectionHeader label={section.section_name} time={`${section.start_date}-${section.finish_date}`} />
                <Masonry images={section.media} />
              </div>
            ))}
          </>
        )
      }
    </main>
  );

}
