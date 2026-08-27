"use client"
import { Card, Button } from "azeriand-library"
import useGlobalStore from "../src/stores/global.store";
import useUploadStore from "../src/stores/upload.store";
import useMediaUiStore from "../src/stores/media-ui.store";
import useEventStore from "../src/stores/event.store";
import useAuthStore from "../src/stores/auth.store";
import { AiFillHome } from "react-icons/ai";
import { TbPhotoPlus } from "react-icons/tb";
import { PiFolderUserBold } from "react-icons/pi";
import { FiDownload, FiTrash2 } from "react-icons/fi";
import { HiOutlineArrowsExpand } from "react-icons/hi";
import { useRef, useState } from "react";
import { useParams } from "next/navigation";

export default function Navbar() {

    const params = useParams();
    const eventSlug = params["event-slug"] as string;
    const fileInputRef = useRef<HTMLInputElement>(null);

    const { state, changeState } = useGlobalStore();
    const { enqueueFiles } = useUploadStore();
    const { isSelectionMode, selectedIds, downloading, downloadSelected, toggleSelectedMode, selectAll, deselectAll, downloadProgress } = useMediaUiStore();
    const { event, isDemo } = useEventStore();
    const { user } = useAuthStore();
    const [fileError, setFileError] = useState<string | null>(null);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [showMovePanel, setShowMovePanel] = useState(false);
    const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null);

    // Calcular IDs visibles según el filtro actual
    const visibleMediaIds = event?.sections
        .flatMap((section) => section.media)
        .filter((media) => {
            if (state === 'home') return true;
            if (state === 'myPhotos') return media.user_id === user?.id;
            if (state === 'favPhotos') return media.liked;
            return true;
        })
        .map((media) => media.media_id) ?? [];

    const allSelected = visibleMediaIds.length > 0 && visibleMediaIds.every((id) => selectedIds.has(id));

    const handleSelectAllToggle = () => {
        if (allSelected) {
            deselectAll();
        } else {
            selectAll(visibleMediaIds);
        }
    };

    // Solo puede mover/borrar si es admin o está en "Mis Fotos", y no es demo
    const canMoveAndDelete = !isDemo && (user?.isAdmin || state === 'myPhotos');

    const handleDelete = () => {
        if (selectedIds.size === 0) return;
        setShowDeleteConfirm(true);
    };

    const confirmDelete = async () => {
        const mediaIds = Array.from(selectedIds);
        try {
            const response = await fetch(`/api/event/${eventSlug}/media/bulk`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mediaIds }),
            });

            if (!response.ok) {
                const text = await response.text();
                console.error("Error al eliminar:", text);
                return;
            }

            // Actualizar el event store: quitar las media eliminadas
            if (event) {
                const deletedSet = new Set(mediaIds);
                const updatedSections = event.sections.map((section) => ({
                    ...section,
                    media: section.media.filter((m) => !deletedSet.has(m.media_id)),
                }));
                useEventStore.setState({ event: { ...event, sections: updatedSections } });
            }

            deselectAll();
            toggleSelectedMode();
        } catch (error) {
            console.error("Error al eliminar:", error);
        } finally {
            setShowDeleteConfirm(false);
        }
    };

    const handleMove = () => {
        if (selectedIds.size === 0) return;
        setShowMovePanel(true);
        setSelectedSectionId(null);
    };

    const confirmMove = async () => {
        if (!selectedSectionId) return;
        const mediaIds = Array.from(selectedIds);
        try {
            const response = await fetch(`/api/event/${eventSlug}/media/bulk`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mediaIds, sectionId: selectedSectionId }),
            });

            if (!response.ok) {
                const text = await response.text();
                console.error("Error al mover:", text);
                return;
            }

            // Actualizar el event store: mover media a la nueva sección
            if (event) {
                const movedSet = new Set(mediaIds);
                const movedMedia = event.sections
                    .flatMap((s) => s.media)
                    .filter((m) => movedSet.has(m.media_id))
                    .map((m) => ({ ...m, section_id: Number(selectedSectionId) }));

                const updatedSections = event.sections.map((section) => {
                    // Quitar las movidas de su sección original
                    const filtered = section.media.filter((m) => !movedSet.has(m.media_id));
                    // Añadir las movidas a la sección destino
                    if (String(section.section_id) === String(selectedSectionId)) {
                        return { ...section, media: [...filtered, ...movedMedia] };
                    }
                    return { ...section, media: filtered };
                });
                useEventStore.setState({ event: { ...event, sections: updatedSections } });
            }

            deselectAll();
            toggleSelectedMode();
        } catch (error) {
            console.error("Error al mover:", error);
        } finally {
            setShowMovePanel(false);
            setSelectedSectionId(null);
        }
    };

    const updateState = (newState: "home" | "myPhotos" | "favPhotos" | "personalFolder") => {
        
        if (newState === "personalFolder" && state === 'favPhotos') return;
        if (newState === "personalFolder") {
            changeState('myPhotos');
        } else {
            changeState(newState);
        }
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    const defaultButtonProps = {appearance: 'ghost', intensity: 700, style: { color: '#9D7BD6' }};
    const selectedButtonProps = {intensity: 950};

    const homeButtonProps = state === "home" ? selectedButtonProps : defaultButtonProps;
    const personalFolderButtonProps = state === "myPhotos" || state === "favPhotos" ? selectedButtonProps : defaultButtonProps;

    return(
        <>
            {/* Popup confirmación de borrado */}
            {showDeleteConfirm && (
                <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4" style={{ backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)' }} onClick={() => setShowDeleteConfirm(false)}>
                    <div className="bg-[#FFFCF8] rounded-2xl p-6 max-w-xs w-full flex flex-col items-center gap-y-4" onClick={(e) => e.stopPropagation()}>
                        <FiTrash2 size={32} className="text-red-400" />
                        <p className="text-center text-sm" style={{ color: '#5A463A' }}>
                            ¿Eliminar {selectedIds.size} {selectedIds.size === 1 ? 'elemento' : 'elementos'}?
                        </p>
                        <p className="text-center text-xs text-gray-400">Esta acción no se puede deshacer</p>
                        <div className="flex gap-x-3 w-full">
                            <button className="flex-1 py-2 rounded-xl text-sm font-medium border border-gray-200" style={{ color: '#5A463A' }} onClick={() => setShowDeleteConfirm(false)}>
                                Cancelar
                            </button>
                            <button className="flex-1 py-2 rounded-xl text-sm font-medium bg-red-400 text-white" onClick={confirmDelete}>
                                Eliminar
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Panel de mover a sección */}
            {showMovePanel && (
                <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4" style={{ backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)' }} onClick={() => setShowMovePanel(false)}>
                    <div className="bg-[#FFFCF8] rounded-2xl p-6 max-w-xs w-full flex flex-col gap-y-4" onClick={(e) => e.stopPropagation()}>
                        <p className="text-center text-sm font-medium" style={{ color: '#5A463A' }}>Mover a sección</p>
                        <div className="flex flex-col gap-y-2 max-h-60 overflow-y-auto">
                            {event?.sections.map((section) => (
                                <label key={section.section_id} className="flex items-center gap-x-3 p-2 rounded-xl cursor-pointer hover:bg-purple-50 transition-colors">
                                    <input
                                        type="radio"
                                        name="move-section"
                                        checked={selectedSectionId === section.section_id}
                                        onChange={() => setSelectedSectionId(section.section_id)}
                                        className="w-4 h-4 accent-purple-500"
                                    />
                                    <span className="text-sm" style={{ color: '#5A463A' }}>{section.section_name}</span>
                                </label>
                            ))}
                        </div>
                        <div className="flex gap-x-3 w-full">
                            <button className="flex-1 py-2 rounded-xl text-sm font-medium border border-gray-200" style={{ color: '#5A463A' }} onClick={() => setShowMovePanel(false)}>
                                Cancelar
                            </button>
                            <button
                                className={`flex-1 py-2 rounded-xl text-sm font-medium text-white ${selectedSectionId ? 'bg-purple-500' : 'bg-purple-300 cursor-not-allowed'}`}
                                onClick={confirmMove}
                            >
                                Mover
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Blur gradient inferior */}
            <div className="fixed bottom-0 left-0 right-0 h-32 pointer-events-none z-[99]" style={{
                backdropFilter: 'blur(4px)',
                WebkitBackdropFilter: 'blur(4px)',
                maskImage: 'linear-gradient(to top, black 0%, black 40%, transparent 100%)',
                WebkitMaskImage: 'linear-gradient(to top, black 0%, black 40%, transparent 100%)',
            }} />

            {isSelectionMode ? (
                /* Barra de selección */
                <div className="grid grid-cols-3 items-center px-6 fixed bottom-8 left-0 right-0 w-full z-[100]" style={{ willChange: "transform", position: 'fixed' }}>
                    {/* Izquierda: mover + borrar (solo si tiene permiso) */}
                    <div className="flex gap-x-2 justify-start">
                        {canMoveAndDelete && (
                            <>
                                <Button appearance='mate' color="white" intensity={500} size='sm' className="!rounded-full bg-white/15! backdrop-blur-md! border-white/20! text-white! md:text-purple-700! md:border-purple-200! md:bg-purple-50!" style={{ width: '40px', height: '40px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={handleMove}>
                                    <HiOutlineArrowsExpand size={18} />
                                </Button>
                                <Button appearance='mate' color="white" intensity={500} size='sm' className="!rounded-full bg-white/15! backdrop-blur-md! border-white/20! text-white! md:text-purple-700! md:border-purple-200! md:bg-purple-50!" style={{ width: '40px', height: '40px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={handleDelete}>
                                    <FiTrash2 size={18} />
                                </Button>
                            </>
                        )}
                    </div>

                    {/* Centro: contador */}
                    <span className="text-sm font-black text-white/80 md:text-purple-700 text-center">
                        {selectedIds.size} seleccionados
                    </span>

                    {/* Derecha: descargar */}
                    <div className="flex justify-end">
                        <button
                            className="relative !rounded-full bg-white/15 backdrop-blur-md border border-white/20 text-white md:text-purple-700 md:border-purple-200 md:bg-purple-50 flex items-center justify-center"
                            style={{ width: '40px', height: '40px' }}
                            onClick={() => { if (!downloading && selectedIds.size > 0) downloadSelected(); }}
                        >
                            {downloading ? (
                                <svg width="28" height="28" className="transform -rotate-90">
                                    <circle cx="14" cy="14" r="11" fill="none" stroke="currentColor" strokeWidth="2.5" opacity="0.2" />
                                    <circle cx="14" cy="14" r="11" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
                                        strokeDasharray={2 * Math.PI * 11}
                                        strokeDashoffset={2 * Math.PI * 11 - (downloadProgress / 100) * 2 * Math.PI * 11}
                                        className="transition-all duration-200 ease-out"
                                    />
                                </svg>
                            ) : (
                                <FiDownload size={18} />
                            )}
                        </button>
                    </div>
                </div>
            ) : (
                /* Barra normal */
                <div className="flex justify-between px-6 items-center gap-x-3 fixed bottom-4 left-0 right-0 w-full z-[100]" style={{ willChange: "transform" }}>
                    <Card noPadding className="flex rounded-full p-1">
                        <Button appearance='mate' color="purple" className="rounded-full px-7! py-2! flex flex-col" onClick={() => updateState("home")} {...homeButtonProps}>
                            <AiFillHome size={16}/>
                            <p className='text-xs'>Todas</p>
                        </Button>
                        <Button appearance="mate" color="purple" className="rounded-full px-7! py-2! flex flex-col" onClick={() => updateState("personalFolder")} {...personalFolderButtonProps}>
                            <PiFolderUserBold size={16}/>
                            <p className="text-xs">Mis fotos</p>
                        </Button>
                    </Card>

                    {!isDemo && (
                        <>
                            <Button appearance='mate' color="white" intensity={500} size='md' className="!rounded-full bg-white/15! backdrop-blur-md! border-white/20! text-white! md:text-[#9D7BD6]! md:border-purple-500! md:bg-purple-200!" style={{ width: '48px', height: '48px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }} icon={<TbPhotoPlus size={24}/>} onClick={() => fileInputRef.current?.click()}></Button>
                            <input ref={fileInputRef} type="file" accept="image/*,video/*,.heic,.heif,.mov,.mp4" multiple className="hidden" onChange={(e) => {
                                const files = Array.from(e.target.files || []);
                                if (files.length === 0) return;

                                if (files.length > 20) {
                                    setFileError("Puedes seleccionar hasta 20 archivos a la vez.");
                                    e.target.value = "";
                                    return;
                                }

                                setFileError(null);
                                enqueueFiles(files, eventSlug);
                                e.target.value = "";
                            }}/>
                        </>
                    )}

                    {fileError && <p className="absolute -top-10 left-0 right-0 text-center text-red-500 text-sm bg-white/95 rounded-lg py-1 px-2">{fileError}</p>}
                </div>
            )}
        </>
    )
}
