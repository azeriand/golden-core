"use client"
import 'azeriand-library/dist/styles.css';
import AuthPopup from './components/auth-popup';
import Navbar from './components/navbar';
import useAuthStore from './src/stores/auth.store';
import useEventStore from './src/stores/event.store';
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import "./globals.css";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {

  const { loadUser, authenticated, loading } = useAuthStore();
  const { event } = useEventStore();
  const [mode, setMode] = useState<"signup" | "login">("signup");
  const pathname = usePathname();
  const isDemoRoute = pathname === "/demo";
 
  useEffect(() => {
    loadUser();
  }, []);

  return (
    <html lang="es">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
      </head>
      <body className="min-h-screen">
        {!loading && !authenticated && !isDemoRoute && (<AuthPopup />)}
        <div className='mx-auto flex min-h-screen w-full max-w-4xl flex-col'>
          <main className="flex flex-1 px-4 pt-4 py-4 pb-28 sm:px-1">
            {children}
          </main>
          {authenticated && event && <Navbar/>}
        </div>
      </body>
    </html>
  );
}
