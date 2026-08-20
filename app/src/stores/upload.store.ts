import { create } from "zustand";
import { Media } from "@/app/dto/media";
import { uploadFile } from "@/app/upload-xhr";
import useGlobalStore from "./global.store";
import useEventStore from "./event.store";

export interface UploadItem {
  id: string;
  file: File;
  previewUrl: string;
  status: "queued" | "uploading" | "success" | "failed" | "exhausted";
  progress: number;
  retryCount: number;
  error: string | null;
  mediaResult: Media | null;
}

export interface UploadStore {
  items: UploadItem[];
  activeCount: number;

  enqueueFiles: (files: File[], eventSlug: string) => void;
  retryItem: (id: string) => void;
  dismissItem: (id: string) => void;
  processQueue: () => void;
}

const useUploadStore = create<UploadStore>((set, get) => ({
  items: [],
  activeCount: 0,

  enqueueFiles: (files: File[], _eventSlug: string) => {
    if (files.length === 0) return;

    const newItems: UploadItem[] = files.map((file) => ({
      id: crypto.randomUUID(),
      file,
      previewUrl: URL.createObjectURL(file),
      status: "queued" as const,
      progress: 0,
      retryCount: 0,
      error: null,
      mediaResult: null,
    }));

    set((state) => ({
      items: [...state.items, ...newItems],
    }));

    // Switch global state to 'myPhotos'
    useGlobalStore.getState().changeState("myPhotos");

    get().processQueue();
  },

  processQueue: () => {
    const { items, activeCount } = get();

    const queuedItems = items.filter((item) => item.status === "queued");
    const slotsAvailable = 3 - activeCount;

    if (slotsAvailable <= 0 || queuedItems.length === 0) return;

    const itemsToProcess = queuedItems.slice(0, slotsAvailable);

    // Mark items as uploading and increment activeCount
    set((state) => ({
      activeCount: state.activeCount + itemsToProcess.length,
      items: state.items.map((item) =>
        itemsToProcess.some((p) => p.id === item.id)
          ? { ...item, status: "uploading" as const, progress: 0 }
          : item
      ),
    }));

    // Start upload for each item
    for (const item of itemsToProcess) {
      const url = `/api/event/${getEventSlug()}/media`;

      uploadFile({
        file: item.file,
        url,
        date: new Date().toISOString(),
        onProgress: (percent: number) => {
          set((state) => ({
            items: state.items.map((i) =>
              i.id === item.id ? { ...i, progress: percent } : i
            ),
          }));
        },
        timeoutMs: 30000,
      })
        .then((media: Media) => {
          set((state) => ({
            activeCount: state.activeCount - 1,
            items: state.items.map((i) =>
              i.id === item.id
                ? { ...i, status: "success" as const, progress: 100, mediaResult: media }
                : i
            ),
          }));
          // Add the uploaded media to the event store
          const eventState = useEventStore.getState();
          if (eventState.event) {
            const sections = eventState.event.sections.map((section) => {
              if (section.section_id === media.section_id) {
                return { ...section, media: [...section.media, media] };
              }
              return section;
            });
            // If media has no section or section not found, add to first section
            const added = sections.some((s) => s.media.includes(media));
            if (!added && sections.length > 0) {
              sections[0] = { ...sections[0], media: [...sections[0].media, media] };
            }
            useEventStore.setState({ event: { ...eventState.event, sections } });
          }
          // Process next queued items
          get().processQueue();
        })
        .catch((error: Error) => {
          set((state) => ({
            activeCount: state.activeCount - 1,
            items: state.items.map((i) =>
              i.id === item.id
                ? { ...i, status: "failed" as const, error: error.message }
                : i
            ),
          }));
          // Process next queued items
          get().processQueue();
        });
    }
  },

  retryItem: (id: string) => {
    const { items } = get();
    const item = items.find((i) => i.id === id);

    if (!item) return;

    if (item.retryCount >= 3) {
      set((state) => ({
        items: state.items.map((i) =>
          i.id === id ? { ...i, status: "exhausted" as const } : i
        ),
      }));
      return;
    }

    // Increment retryCount, reset progress, set to uploading
    set((state) => ({
      items: state.items.map((i) =>
        i.id === id
          ? {
              ...i,
              status: "uploading" as const,
              progress: 0,
              retryCount: i.retryCount + 1,
              error: null,
            }
          : i
      ),
      activeCount: state.activeCount + 1,
    }));

    const updatedItem = get().items.find((i) => i.id === id)!;
    const url = `/api/event/${getEventSlug()}/media`;

    uploadFile({
      file: updatedItem.file,
      url,
      date: new Date().toISOString(),
      onProgress: (percent: number) => {
        set((state) => ({
          items: state.items.map((i) =>
            i.id === id ? { ...i, progress: percent } : i
          ),
        }));
      },
      timeoutMs: 30000,
    })
      .then((media: Media) => {
        set((state) => ({
          activeCount: state.activeCount - 1,
          items: state.items.map((i) =>
            i.id === id
              ? { ...i, status: "success" as const, progress: 100, mediaResult: media }
              : i
          ),
        }));
        // Add the uploaded media to the event store
        const eventState = useEventStore.getState();
        if (eventState.event) {
          const sections = eventState.event.sections.map((section) => {
            if (section.section_id === media.section_id) {
              return { ...section, media: [...section.media, media] };
            }
            return section;
          });
          const added = sections.some((s) => s.media.includes(media));
          if (!added && sections.length > 0) {
            sections[0] = { ...sections[0], media: [...sections[0].media, media] };
          }
          useEventStore.setState({ event: { ...eventState.event, sections } });
        }
        get().processQueue();
      })
      .catch((error: Error) => {
        set((state) => ({
          activeCount: state.activeCount - 1,
          items: state.items.map((i) =>
            i.id === id
              ? { ...i, status: "failed" as const, error: error.message }
              : i
          ),
        }));
        get().processQueue();
      });
  },

  dismissItem: (id: string) => {
    const { items } = get();
    const item = items.find((i) => i.id === id);

    if (!item) return;

    // Revoke the object URL to free memory
    URL.revokeObjectURL(item.previewUrl);

    set((state) => ({
      items: state.items.filter((i) => i.id !== id),
    }));
  },
}));

/**
 * Helper to get the current event slug from the URL pathname.
 * The event page URL is structured as /[event-slug].
 */
function getEventSlug(): string {
  if (typeof window === "undefined") return "";
  const pathSegments = window.location.pathname.split("/").filter(Boolean);
  return pathSegments[0] || "";
}

export default useUploadStore;
