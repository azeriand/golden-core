"use client"
import 'azeriand-library/dist/styles.css';
import AuthPopup from './components/auth-popup';
import Navbar from './components/navbar';
import useAuthStore from './src/stores/auth.store';
import { useEffect, useState } from 'react';
import "./globals.css";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {

  const { loadUser, authenticated, loading } = useAuthStore();
  const [mode, setMode] = useState<"signup" | "login">("signup");
 
  useEffect(() => {
    loadUser();
  }, []);

  return (
    <html lang="es">
      <body className="min-h-screen">
        {!loading && !authenticated && (<AuthPopup />)}
        <div className='mx-auto flex min-h-screen w-full max-w-4xl flex-col'>
          <main className="flex flex-1 pt-4 py-4 pb-28">
            {children}
          </main>
          {authenticated && <Navbar/>}
        </div>
      </body>
    </html>
  );
}
