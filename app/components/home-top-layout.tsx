"use client"
import { Button } from "azeriand-library"
import { FaShare } from "react-icons/fa"
import { IoSettingsSharp } from "react-icons/io5";
import { TbLogout } from "react-icons/tb";
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
                className={`${isStuck ? 'fixed top-0 left-0 right-0 max-w-4xl mx-auto z-50 animate-slide-down' : ''} bg-[#FFFCF8]/95 backdrop-blur-md w-full px-4 py-3 transition-all duration-300 ease-in-out`}
            >
                {/* Layout compacto */}
                <div className={`flex items-center justify-between transition-all duration-300 ease-in-out ${isStuck ? 'opacity-100 translate-y-0' : 'opacity-0 h-0 overflow-hidden -translate-y-2'}`}>
                    <div className='flex items-baseline gap-x-2'>
                        <h1 className={`font-semibold ${greatVibes.className} text-purple-700`} style={{ fontSize: '1.85rem' }}>{event_name}</h1>
                        <p className={`${greatVibes.className} text-purple-500`} style={{ fontSize: '1.25rem' }}>{event_date}</p>
                    </div>
                    <div className="flex gap-x-2 items-stretch">
                        {isSelectionMode && selectedIds.size > 0 && (
                            <span className="text-sm flex items-center" style={{ color: '#5A463A' }}>{selectedIds.size} seleccionadas</span>
                        )}
                        {!isSelectionMode && (
                            <Button appearance='mate' color="purple" intensity={500} size='sm' className="py-2!" onClick={toggleSelectedMode}>
                                Seleccionar
                            </Button>
                        )}
                        {isSelectionMode && (
                            <>
                                <Button appearance='mate' color="purple" intensity={500} size='sm' className="py-2!" onClick={handleSelectAllToggle}>
                                    {allSelected ? "Deseleccionar todo" : "Seleccionar todo"}
                                </Button>
                                <Button appearance='mate' color='purple' intensity={700} size='sm' className="py-2!" onClick={handleDownload}>
                                    {downloading ? "Descargando..." : "Descargar"}
                                </Button>
                                <Button appearance='mate' color="purple" intensity={500} size='sm' className="py-2!" onClick={toggleSelectedMode}>
                                    Cancelar
                                </Button>
                            </>
                        )}
                        <Button appearance='mate' color="purple" intensity={700} size='sm' className="aspect-square!" onClick={shareEvent}>
                            <FaShare size={14} />
                        </Button>
                        {!isSelectionMode && (
                            <>
                                {/* <Button appearance='mate' color="purple" intensity={700} size='sm' className="aspect-square h-8!">
                                    <IoSettingsSharp size={14} />
                                </Button> */}
                                <Button appearance='outlined' color="amber" intensity={700} size='sm' className="aspect-square!" style={{ color: '#5A463A' }} onClick={logout}>
                                    <TbLogout size={14} />
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
                    <div className='flex w-full justify-between items-stretch'>
                        <Button appearance='mate' size="sm" color="amber" intensity={700} className="rounded-md" onClick={shareEvent}>
                            <FaShare size={14} className="inline mr-1"/> Compartir enlace
                        </Button>
                        <div className="flex gap-x-2 items-center">
                            {isSelectionMode && selectedIds.size > 0 && (
                                <span className="text-sm flex items-center" style={{ color: '#5A463A' }}>{selectedIds.size} seleccionadas</span>
                            )}
                            {!isSelectionMode && (
                                <Button appearance='mate' color="purple" intensity={500} size='sm' className="py-2!" onClick={toggleSelectedMode}>
                                    Seleccionar
                                </Button>
                            )}
                            {isSelectionMode && (
                                <>
                                    <Button appearance='mate' color="purple" intensity={500} size='sm' className="py-2!" onClick={handleSelectAllToggle}>
                                        {allSelected ? "Deseleccionar todo" : "Seleccionar todo"}
                                    </Button>
                                    <Button appearance='mate' color='purple' intensity={700} size='sm' className="py-2!" onClick={handleDownload}>
                                        {downloading ? "Descargando..." : "Descargar"}
                                    </Button>
                                    <Button appearance='mate' color="purple" intensity={500} size='sm' className="py-2!" onClick={toggleSelectedMode}>
                                        Cancelar
                                    </Button>
                                </>
                            )}
                            {!isSelectionMode && (
                                <>
                                    {/* <Button appearance='mate' color="purple" intensity={700} size='sm' className="aspect-square h-8!">
                                        <IoSettingsSharp size={14} />
                                    </Button> */}
                                    <Button appearance='outlined' color="amber" intensity={700} size='sm' className="aspect-square!" style={{ color: '#5A463A' }} onClick={logout}>
                                        <TbLogout size={14} />
                                    </Button>
                                </>
                            )}
                        </div>
                    </div>
                    <hr className='w-full border-t border-stone-300' />
                </div>
            </div>
        </>
    )
}
