import { create } from "zustand";

interface ErrorState {
  /** Current user-facing error message, or null when no popup is shown. */
  message: string | null;
  /**
   * Show an error popup. If the device is offline, an offline-specific message
   * takes precedence (so any failed request while offline reads clearly). Pass a
   * specific `message` for the online-failure case.
   */
  showError: (message?: string) => void;
  /** Show the offline message explicitly (e.g. before even attempting a request). */
  showOffline: () => void;
  /** Dismiss the popup. */
  clearError: () => void;
}

const OFFLINE_MESSAGE =
  "Sin conexión. Revisa tu internet e inténtalo de nuevo.";
const GENERIC_MESSAGE =
  "Algo salió mal. Inténtalo de nuevo.";

/** True when the browser reports it is offline. */
function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/**
 * Global error popup store. Any non-upload request failure (including offline
 * attempts) surfaces here so the user always gets feedback. Media uploads are
 * intentionally excluded — they have their own per-item placeholder UX.
 */
const useErrorStore = create<ErrorState>((set) => ({
  message: null,

  showError: (message?: string) =>
    set({
      // Offline is the most useful thing to say when the network is the cause.
      message: isOffline() ? OFFLINE_MESSAGE : message || GENERIC_MESSAGE,
    }),

  showOffline: () => set({ message: OFFLINE_MESSAGE }),

  clearError: () => set({ message: null }),
}));

export default useErrorStore;
