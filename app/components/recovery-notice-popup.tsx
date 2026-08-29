"use client";

import { Button, Card } from "azeriand-library";
import useUploadStore from "@/app/src/stores/upload.store";

/**
 * One-time Spanish notice shown after a cross-reload recovery pass surfaced at
 * least one item that CANNOT be auto-resumed — a video or an oversized image
 * (their bytes are not persisted, only a thumbnail). It tells the user those
 * files must be re-uploaded manually. Renders nothing unless the upload store's
 * `recoveryNotice` flag is set; dismissing clears the flag.
 */
export default function RecoveryNoticePopup() {
  const recoveryNotice = useUploadStore((state) => state.recoveryNotice);
  const dismiss = useUploadStore((state) => state.dismissRecoveryNotice);

  if (!recoveryNotice) return null;

  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/30 p-4"
      style={{
        backdropFilter: "blur(5px)",
        WebkitBackdropFilter: "blur(5px)",
        willChange: "transform",
      }}
      onClick={dismiss}
    >
      {/* Stop propagation on the content wrapper so clicking inside the card
          does not dismiss (only the backdrop or the button does). */}
      <div onClick={(e) => e.stopPropagation()}>
        <Card
          appearance="mate"
          color="white"
          intensity={200}
          className="flex flex-col gap-y-4 items-center max-w-sm text-center"
          style={{ boxShadow: "0 20px 40px rgba(0, 0, 0, 0.35)", padding: "2.5rem" }}
        >
          <h2 className="text-purple-700 font-semibold text-lg">
            Subidas interrumpidas
          </h2>
          <p className="text-sm text-gray-600">
            Los videos y las imágenes grandes no se reanudan automáticamente tras
            recargar la página. Vuelve a seleccionarlos para subirlos de nuevo.
          </p>
          <Button
            appearance="mate"
            color="purple"
            intensity={200}
            size="sm"
            className="rounded-xl! border-purple-200!"
            style={{ color: "#9D7BD6" }}
            onClick={dismiss}
          >
            Entendido
          </Button>
        </Card>
      </div>
    </div>
  );
}
