"use client"
import { Button } from "azeriand-library"
import { IoCloseOutline } from "react-icons/io5";
import { MdOutlineRadioButtonUnchecked, MdOutlineCheckCircleOutline } from "react-icons/md";
import { FiLogOut } from "react-icons/fi";
import { Great_Vibes } from 'next/font/google'
import useMediaUiStore from "../src/stores/media-ui.store";
import useAuthStore from "../src/stores/auth.store";
import { useEffect, useRef, useState } from "react";

const greatVibes = Great_Vibes({
  subsets: ['latin'],
  weight: '400',
})

export default function HomeTopLayout({ event_name, event_date, visibleMediaIds }: { event_name: string, event_date: string, visibleMediaIds: number[] }) {

    const { downloadSelected, downloading, selectedIds, isSelectionMode, toggleSelectedMode, selectAll, deselectAll } = useMediaUiStore();
    const logout = useAuthStore((s) => s.logout);
    const [isStuck, setIsStuck] = useState(false);
    const imgRef = useRef<HTMLImageElement>(null);

    const allSelected = visibleMediaIds.length > 0 && visibleMediaIds.every((id) => selectedIds.has(id));

    const handleSelectAllToggle = () => {
        if (allSelected) {
            deselectAll();
        } else {
            selectAll(visibleMediaIds);
        }
    };

    // Observar la imagen: cuando desaparece del viewport → stuck
    useEffect(() => {
        if (!imgRef.current) return;

        const observer = new IntersectionObserver(
            ([entry]) => setIsStuck(!entry.isIntersecting),
            { threshold: 0 }
        );

        observer.observe(imgRef.current);
        return () => observer.disconnect();
    }, []);

    const handleDownload = () => {
        if (downloading || selectedIds.size === 0) return;
        downloadSelected();
    }

    return (
        <>
            {/* La imagen se va con el scroll */}
            <img
                ref={imgRef}
                src="https://img.magnific.com/free-photo/golden-wedding-rings-white-rose-from-wedding-bouquet_8353-10467.jpg?semt=ais_hybrid&w=740&q=80"
                alt="Imagen del evento"
                className="w-full h-auto rounded-t-2xl"
            />

            {/* Container estático con título, fecha y botón de seleccionar */}
            <div className="bg-[#FFFCF8]/95 backdrop-blur-md w-full px-6 py-3">
                <div className="flex flex-col items-center gap-y-1">
                    <h1 className={`text-2xl font-semibold ${greatVibes.className} text-purple-700`}>{event_name}</h1>
                    <p className={`text-2xl font-bold ${greatVibes.className} text-purple-500`}>{event_date}</p>
                    <hr className='w-full border-t border-stone-300 mt-2' />
                    <div className="flex w-full justify-end mt-4 -mb-3 gap-x-2">
                        {!isSelectionMode && (
                            <>
                                <Button appearance='mate' color="purple" intensity={200} size='sm' className="py-2! text-xs! rounded-xl! border-purple-200!" style={{ color: '#9D7BD6' }} onClick={toggleSelectedMode}>
                                    Seleccionar
                                </Button>
                                <Button appearance='mate' color="purple" intensity={200} size='sm' className="!rounded-full border-purple-200!" style={{ width: '32px', height: '32px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9D7BD6' }} onClick={() => logout()}>
                                    <FiLogOut size={16} />
                                </Button>
                            </>
                        )}
                        {isSelectionMode && (
                            <>
                                <Button appearance='mate' color="purple" intensity={200} size='sm' className="!rounded-full border-purple-200!" style={{ width: '32px', height: '32px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9D7BD6' }} onClick={handleSelectAllToggle}>
                                    {allSelected ? <MdOutlineCheckCircleOutline size={18} /> : <MdOutlineRadioButtonUnchecked size={18} />}
                                </Button>
                                <Button appearance='mate' color="purple" intensity={200} size='sm' className="!rounded-full border-purple-200!" style={{ width: '32px', height: '32px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9D7BD6' }} onClick={toggleSelectedMode}>
                                    <IoCloseOutline size={18} />
                                </Button>
                            </>
                        )}
                    </div>
                </div>
            </div>

            {/* Barra compacta: fixed cuando stuck */}
            {isStuck && (
                <div className="fixed top-0 left-0 right-0 max-w-4xl mx-auto z-50 w-full px-6 py-3">
                    {/* Blur gradient overlay */}
                    <div className="absolute inset-0 pointer-events-none" style={{
                        height: '160px',
                        backdropFilter: 'blur(4px)',
                        WebkitBackdropFilter: 'blur(4px)',
                        background: 'linear-gradient(180deg, rgba(0,0,0,0.8) -20%, rgba(0,0,0,0) 40%)',
                        maskImage: 'linear-gradient(to bottom, black 0%, black 40%, transparent 70%)',
                        WebkitMaskImage: 'linear-gradient(to bottom, black 0%, black 40%, transparent 70%)',
                    }} />

                    {/* Layout compacto */}
                    <div className="flex items-center justify-between relative">
                        <h1 className="font-black text-white" style={{ fontSize: '1.2rem', fontWeight: 900 }}>{event_name}</h1>
                        <div className="flex gap-x-2 items-center">
                            {!isSelectionMode && (
                                <Button appearance='mate' color="white" intensity={500} size='sm' className="py-2! rounded-xl! bg-white/15! backdrop-blur-md! border-white/20! text-white!" onClick={toggleSelectedMode}>
                                    Seleccionar
                                </Button>
                            )}
                            {isSelectionMode && (
                                <>
                                    <Button appearance='mate' color="white" intensity={500} size='sm' className="!rounded-full bg-white/15! backdrop-blur-md! border-white/20! text-white!" style={{ width: '32px', height: '32px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={handleSelectAllToggle}>
                                        {allSelected ? <MdOutlineCheckCircleOutline size={18} /> : <MdOutlineRadioButtonUnchecked size={18} />}
                                    </Button>
                                    <Button appearance='mate' color="white" intensity={500} size='sm' className="!rounded-full bg-white/15! backdrop-blur-md! border-white/20! text-white!" style={{ width: '32px', height: '32px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={toggleSelectedMode}>
                                        <IoCloseOutline size={18} />
                                    </Button>
                                </>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </>
    )
}
