"use client"
import 'azeriand-library/dist/styles.css';
import ZoomPhoto from './components/zoom-photo';
import Navbar from './components/navbar';
import "./globals.css";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        {/* <ZoomPhoto src="https://picsum.photos/id/1/200/300" /> */}
        <div className='mx-auto flex min-h-screen w-full max-w-4xl flex-col'>
          <main className="flex flex-1 p-4">
            {children}
          </main>
          <Navbar />
        </div>
      </body>
    </html>
  );
}
