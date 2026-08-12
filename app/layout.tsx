"use client"
import 'azeriand-library/dist/styles.css';
import ZoomPhoto from './components/zoom-photo';
import LogIn from './components/log-in';
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
    <html lang="en">
      <body className="min-h-screen">
        {/* <ZoomPhoto src="https://picsum.photos/id/1/200/300" /> */}
        {!loading && !authenticated && (<AuthPopup />)}
        <div className='mx-auto flex min-h-screen w-full max-w-4xl flex-col'>
          <main className="flex flex-1 p-4">
            {children}
          </main>
          <Navbar/>
        </div>
      </body>
    </html>
  );
}
