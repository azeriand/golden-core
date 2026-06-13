import { createStore } from "zustand";
import axios from "axios";

const useMediaStore = createStore((set) => ({
  
  photos: [],
  isLoading: false,
  error: null,

  loadPhotos: async () => {
    try {
      const response = await axios.get("https://api/[event-slug]");

      console.log(response.data); // Aquí están los datos de la API
    } catch (error) {
    console.error("Error", error);
  }
  },
  addPhoto: () => {},
  removePhoto: () => {},
  updatePhoto: () => {},

}));
