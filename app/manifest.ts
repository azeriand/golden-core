import type { MetadataRoute } from "next";

// Web App Manifest (Next 16 file convention: app/manifest.ts). Makes the app
// installable and defines how it launches from the home screen. Icons reuse the
// existing favicon for now (per product decision).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Golden·Core",
    short_name: "Golden·Core",
    description: "Galería de fotos y videos del evento.",
    start_url: "/",
    display: "standalone",
    background_color: "#FFFCF8",
    theme_color: "#9D7BD6",
    lang: "es",
    icons: [
      {
        // Reusing the app favicon (sizes: 'any' covers install prompts).
        src: "/favicon.ico",
        sizes: "any",
        type: "image/x-icon",
      },
    ],
  };
}
