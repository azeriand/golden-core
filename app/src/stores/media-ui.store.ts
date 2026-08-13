import { createStore } from "zustand";

interface MediaUiState {
  selectedIds: Set<number>;
  likedIds: Set<number>;
  uploadingIds: Set<number>;
  clickedId: number | null;

  toggleSelected: (id: number) => void;
  toggleLiked: (id: number) => void;
  setUploading: (id: number, isUploading: boolean) => void;
  setClicked: (id: number | null) => void;
  clearSelected: () => void;
}

const useMediaUiStore = createStore<MediaUiState>((set) => ({
  selectedIds: new Set<number>(),
  likedIds: new Set<number>(),
  uploadingIds: new Set<number>(),
  clickedId: null,

  toggleSelected: (id: number) =>
    set((state) => {
      const selectedIds = new Set(state.selectedIds);

      if (selectedIds.has(id)) {
        selectedIds.delete(id);
      } else {
        selectedIds.add(id);
      }

      return { selectedIds };
    }
  ),

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

}));

export default useMediaUiStore;