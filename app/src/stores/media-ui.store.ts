import { create } from "zustand";
import useEventStore from "./event.store";

interface MediaUiState {
  selectedIds: Set<number>;
  likedIds: Set<number>;
  uploadingIds: Set<number>;
  clickedId: number | null;
  isSelectionMode: boolean;
  downloading: boolean;
  downloadProgress: number;

  toggleSelected: (id: number) => void;
  toggleSelectedMode : () => void;
  selectAll: (ids: number[]) => void;
  deselectAll: () => void;
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
  downloadProgress: 0,

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

  selectAll: (ids: number[]) => set({
    selectedIds: new Set(ids),
  }),

  deselectAll: () => set({
    selectedIds: new Set<number>(),
  }),

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
      downloadProgress: 0,
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

      const contentLength = response.headers.get("Content-Length");
      const total = contentLength ? parseInt(contentLength, 10) : 0;

      if (!response.body || total === 0) {
        // Sin Content-Length: leer stream e ir incrementando progreso indeterminado
        if (response.body) {
          const reader = response.body.getReader();
          const chunks: BlobPart[] = [];
          let received = 0;
          // Simular progreso basado en chunks recibidos (sin total conocido)
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            received += value.length;
            // Progreso logarítmico: se acerca a 90% pero nunca llega hasta que termine
            const simulated = Math.min(90, Math.round(50 * Math.log10(received / 1024 + 1)));
            set({ downloadProgress: simulated });
          }
          set({ downloadProgress: 100 });
          const blob = new Blob(chunks);
          const url = window.URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = "media.zip";
          document.body.appendChild(link);
          link.click();
          link.remove();
          window.URL.revokeObjectURL(url);
        } else {
          const blob = await response.blob();
          const url = window.URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = "media.zip";
          document.body.appendChild(link);
          link.click();
          link.remove();
          window.URL.revokeObjectURL(url);
        }
      } else {
        // Leer stream con progreso
        const reader = response.body.getReader();
        const chunks: BlobPart[] = [];
        let received = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.length;
          set({ downloadProgress: Math.round((received / total) * 100) });
        }

        const blob = new Blob(chunks);
        const url = window.URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "media.zip";
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.URL.revokeObjectURL(url);
      }

      set({
        selectedIds: new Set<number>(),
        isSelectionMode: false,
      });

    } catch (error) {
      // Download failed (offline, server error, or aborted stream): surface a
      // user-facing, offline-aware error instead of failing silently.
      const { default: useErrorStore } = await import("./error.store");
      useErrorStore.getState().showError("No se pudieron descargar los archivos.");
      console.error("Error downloading media", error);
    } finally {
      set({
        downloading: false,
        downloadProgress: 0,
      });
    }
  },
  

}));

export default useMediaUiStore;