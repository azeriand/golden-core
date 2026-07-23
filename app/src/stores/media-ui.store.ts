import { createStore } from "zustand";

const useMediaUiStore = createStore((set) => ({

  selectedIds: new Set(),
  likedIds: new Set(),
  uploadingIds: new Set(),
  clickedId: null,

  toggleSelected: (id) =>
  set((state) => {
    const selectedIds = new Set(state.selectedIds)

    if (selectedIds.has(id)) {
      selectedIds.delete(id)
    } else {
      selectedIds.add(id)
    }

    return { selectedIds }
  }),

  toggleLiked: (id) =>
  set((state) => {
    const likedIds = new Set(state.likedIds)

    if (likedIds.has(id)) {
      likedIds.delete(id)
    } else {
      likedIds.add(id)
    }

    return { likedIds }
  }),

  setUploading: (id, isUploading) =>
  set((state) => {
    const uploadingIds = new Set(state.uploadingIds)

    if (isUploading) {
      uploadingIds.add(id)
    } else {
      uploadingIds.delete(id)
    }

    return { uploadingIds }
  }),

  setClicked: (id) =>
    set({
      clickedId: id,
    }),

  clearSelected: () =>
    set({
      selectedIds: new Set(),
    }),
    
}));