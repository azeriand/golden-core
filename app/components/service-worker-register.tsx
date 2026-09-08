"use client";

import { useEffect } from "react";
import { registerServiceWorker } from "@/app/src/lib/pwa";

/**
 * Registers the PWA service worker on mount (production-only; the helper no-ops
 * otherwise). Renders nothing.
 */
export default function ServiceWorkerRegister() {
  useEffect(() => {
    registerServiceWorker();
  }, []);
  return null;
}
