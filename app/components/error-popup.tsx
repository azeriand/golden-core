"use client";

import { Button, Card } from "azeriand-library";
import useErrorStore from "@/app/src/stores/error.store";

/**
 * Global error popup. Shown whenever a non-upload request fails (or is attempted
 * offline). Mounted once in the layout; renders nothing unless the error store
 * holds a message. Media uploads are excluded — they surface failures in their
 * own placeholder UI.
 */
export default function ErrorPopup() {
  const message = useErrorStore((state) => state.message);
  const clearError = useErrorStore((state) => state.clearError);

  if (!message) return null;

  return (
    <div
      className="fixed inset-0 z-[400] flex items-center justify-center bg-black/30 p-4"
      style={{
        backdropFilter: "blur(5px)",
        WebkitBackdropFilter: "blur(5px)",
        willChange: "transform",
      }}
      onClick={clearError}
    >
      <div onClick={(e) => e.stopPropagation()}>
        <Card
          appearance="mate"
          color="white"
          intensity={200}
          className="flex flex-col gap-y-4 items-center max-w-sm text-center"
          style={{ boxShadow: "0 20px 40px rgba(0, 0, 0, 0.35)", padding: "2.5rem" }}
        >
          <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="text-red-500">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
              <path d="M12 8v4m0 4h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <p className="text-sm text-gray-700">{message}</p>
          <Button
            appearance="mate"
            color="purple"
            intensity={200}
            size="sm"
            className="rounded-xl! border-purple-200!"
            style={{ color: "#9D7BD6" }}
            onClick={clearError}
          >
            Entendido
          </Button>
        </Card>
      </div>
    </div>
  );
}
