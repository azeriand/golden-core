"use client"
import { Button } from "azeriand-library"
import { FaShare } from "react-icons/fa"
import { IoSettingsSharp } from "react-icons/io5";
import { TbLogout } from "react-icons/tb";
import { IoCloseOutline } from "react-icons/io5";
import { MdOutlineRadioButtonUnchecked, MdOutlineCheckCircleOutline } from "react-icons/md";
import { Great_Vibes } from 'next/font/google'
import useAuthStore from "../src/stores/auth.store";
import useMediaUiStore from "../src/stores/media-ui.store";
import useEventStore from "../src/stores/event.store";
import { useEffect, useRef, useState } from "react";

const greatVibes = Great_Vibes({
  subsets: ['latin'],
  weight: '400',
})

export default function HomeTopLayout({ event_name, event_date, visibleMediaIds }: { event_name: string, event_date: string, visibleMediaIds: number[] }) {

    const { logout } = useAuthStore();
    const { downloadSelected, downloading, selectedIds, isSelectionMode, toggleSelectedMode, selectAll, deselectAll } = useMediaUiStore();
    const { shareEvent } = useEventStore()
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

            {/* Spacer para compensar la barra fixed */}
            {isStuck && <div className="h-14" />}

            {/* Barra: normal en flujo, fixed cuando stuck */}
            <div
                className={`${isStuck ? 'fixed top-0 left-0 right-0 max-w-4xl mx-auto z-50' : 'bg-[#FFFCF8]/95 backdrop-blur-md'} w-full px-6 py-3 transition-all duration-300 ease-in-out`}
            >
                {/* Blur gradient overlay - solo cuando stuck */}
                {isStuck && (
                    <div className="absolute inset-0 pointer-events-none" style={{
                        height: '150%',
                        backdropFilter: 'blur(4px)',
                        WebkitBackdropFilter: 'blur(4px)',
                        maskImage: 'linear-gradient(to bottom, black 0%, black 40%, transparent 100%)',
                        WebkitMaskImage: 'linear-gradient(to bottom, black 0%, black 40%, transparent 100%)',
                    }} />
                )}

                {/* Layout compacto */}
                <div className={`flex items-center justify-between transition-all duration-300 ease-in-out relative ${isStuck ? 'opacity-100 translate-y-0' : 'opacity-0 h-0 overflow-hidden -translate-y-2'}`}>
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

                {/* Layout expandido */}
                <div className={`flex flex-col items-center gap-y-3 transition-all duration-300 ease-in-out ${isStuck ? 'opacity-0 h-0 overflow-hidden translate-y-2' : 'opacity-100 translate-y-0'}`}>
                    <div className='flex flex-col items-center'>
                        <h1 className={`text-2xl font-semibold ${greatVibes.className} text-purple-700`}>{event_name}</h1>
                        <p className={`text-2xl font-bold ${greatVibes.className} text-purple-500`}>{event_date}</p>
                    </div>
                    {!isSelectionMode && (
                        <div className='flex w-full justify-between items-center'>
                            {/* <Button appearance='mate' size="sm" color="amber" intensity={700} className="rounded-md py-2!" onClick={shareEvent}>
                                <FaShare size={14} className="inline mr-1"/> Compartir enlace
                            </Button>
                            <div className="flex gap-x-2 items-center">
                                <Button appearance='mate' color="purple" intensity={500} size='sm' className="py-2!" onClick={toggleSelectedMode}>
                                    Seleccionar
                                </Button>
                                <Button appearance='outlined' color="amber" intensity={700} size='sm' className="aspect-square!" style={{ color: '#5A463A' }} onClick={logout}>
                                    <TbLogout size={14} />
                                </Button>
                            </div> */}
                        </div>
                    )}
                    <hr className='w-full border-t border-stone-300' />
                </div>
            </div>
        </>
    )
}
