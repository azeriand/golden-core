import { create } from "zustand";
import useEventStore from "./event.store";

interface MediaUiState {
  selectedIds: Set<number>;
  likedIds: Set<number>;
  uploadingIds: Set<number>;
  clickedId: number | null;
  isSelectionMode: boolean;
  downloading: boolean;

  toggleSelected: (id: number) => void;
  toggleSelectedMode : () => void;
  toggleLiked: (id: number) => void;
  setUploading: (id: number, isUploading: boolean) => void;
  setClicked: (id: number | null) => void;
  clearSelected: () => void;
  downloadSelected: () => Promise<void>;
}

const useMediaUiStore = create<MediaUiState>((set, get) => ({

  selectedIds: new Set<number>(),
  likedIds: new Set<number>(),
  uploadingIds: new Set<number>(),
  clickedId: null,
  isSelectionMode: false,
  downloading: false,

  toggleSelected: (id: number) =>
  set((state) => {
    const selectedIds = new Set(state.selectedIds);

    if (selectedIds.has(id)) {
      selectedIds.delete(id);
    } else {
      selectedIds.add(id);
    }

    return { selectedIds };
  }),

  toggleSelectedMode: () => set((state) => ({
    isSelectionMode: !state.isSelectionMode,
    selectedIds: state.isSelectionMode ? new Set<number>() : state.selectedIds,
  })),

  toggleLiked: (id: number) =>
    set((state) => {
      const likedIds = new Set(state.likedIds);

      if (likedIds.has(id)) {
        likedIds.delete(id);
      } else {
        likedIds.add(id);
      }

      return { likedIds };
    }
  ),

  setUploading: (id: number, isUploading: boolean) =>
    set((state) => {
      const uploadingIds = new Set(state.uploadingIds);

      if (isUploading) {
        uploadingIds.add(id);
      } else {
        uploadingIds.delete(id);
      }

      return { uploadingIds };
    }
  ),

  setClicked: (id: number | null) =>
    set({
      clickedId: id,
    }
  ),

  clearSelected: () =>
    set({
      selectedIds: new Set<number>(),
    }
  ),

  downloadSelected: async () => {
    const { selectedIds } = get();

    const mediaIds = Array.from(selectedIds);

    if (mediaIds.length === 0) {
      return;
    }

    const { event } = useEventStore.getState();

    if (!event) {
      return;
    }

    const eventSlug = event.event_slug;

    set({
      downloading: true,
    });

    try {
      const response = await fetch(
        `/api/event/${eventSlug}/media/download`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            mediaIds,
          }),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();

        console.error("DOWNLOAD ERROR", {
          status: response.status,
          statusText: response.statusText,
          body: errorText,
        });

        throw new Error(
          `Error downloading media: ${response.status} ${errorText}`
        );
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");

      link.href = url;
      link.download = "media.zip";

      document.body.appendChild(link);
      link.click();
      link.remove();

      window.URL.revokeObjectURL(url);

      set({
        selectedIds: new Set<number>(),
      });

    } finally {
      set({
        downloading: false,
      });
    }
  },
  

}));

export default useMediaUiStore;