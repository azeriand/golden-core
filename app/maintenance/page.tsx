// Static "site temporarily closed" page shown while MAINTENANCE_MODE is on.
// Reached via a redirect from proxy.ts for every event slug except the single
// allowed one. Plain server component with no data fetching or dependencies.

export const metadata = {
  title: "Web cerrada temporalmente",
  robots: { index: false, follow: false },
};

export default function MaintenancePage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-y-3 px-6 text-center">
      <h1 className="text-2xl font-bold text-amber-700">Golden·Core</h1>
      <p className="text-lg font-semibold text-gray-700">
        La web está cerrada temporalmente
      </p>
      <p className="max-w-md text-sm text-gray-500">
        Estamos realizando tareas de mantenimiento. Vuelve a intentarlo más
        tarde. Gracias por tu paciencia.
      </p>
    </main>
  );
}
