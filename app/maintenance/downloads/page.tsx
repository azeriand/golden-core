// Download screen for the single allowed event (sara-y-lucia-2026-10-03) while
// the site is closed. Reached via a redirect from proxy.ts.
//
// This is a SERVER component on purpose: it reads SWISSTRANSFER_URL from the
// server environment (that variable is server-only and must NOT be exposed to
// the client bundle). Instead of auto-redirecting, it shows an explanatory
// screen with a button that opens the SwissTransfer link.
//
//   - SWISSTRANSFER_URL set   -> explanation + button linking to the link.
//   - SWISSTRANSFER_URL unset -> controlled "not available yet" message, so we
//     never render a button pointing at an empty/invalid URL.

export const metadata = {
  title: "Descarga de fotografías",
  robots: { index: false, follow: false },
};

export default function DownloadsPage() {
  const swissTransferUrl = process.env.SWISSTRANSFER_URL;
  const hasLink = typeof swissTransferUrl === "string" && swissTransferUrl.length > 0;

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-y-4 px-6 text-center">
      <h1 className="text-2xl font-bold text-amber-700">Golden·Core</h1>

      {hasLink ? (
        <>
          <p className="text-lg font-semibold text-gray-700">
            Tus fotografías están listas
          </p>
          <p className="max-w-md text-sm text-gray-500">
            Puedes descargar todas las fotografías del evento desde SwissTransfer.
            Pulsa el botón para abrir el enlace de descarga.
          </p>
          {/* Styled as an <a> (this is a Server Component, so the library
              Button's onClick cannot be used) but matching the app's palette:
              the "mate pink" look used by the primary CTAs — pink-200 surface,
              pink-200 border and the brand pink text (#E83E8C). */}
          <a
            href={swissTransferUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex items-center justify-center rounded-xl border border-pink-200 bg-pink-200 px-6 py-3 text-sm font-semibold transition-colors hover:bg-pink-300"
            style={{ color: "#E83E8C" }}
          >
            Descargar fotografías
          </a>
        </>
      ) : (
        <>
          <p className="text-lg font-semibold text-gray-700">
            Las descargas no están disponibles temporalmente
          </p>
          <p className="max-w-md text-sm text-gray-500">
            El enlace de descarga aún no está configurado. Vuelve a intentarlo
            más tarde o ponte en contacto con el organizador.
          </p>
        </>
      )}
    </main>
  );
}
