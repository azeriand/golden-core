import { Button } from "azeriand-library"
import { FaShare } from "react-icons/fa"
import { IoSettingsSharp } from "react-icons/io5";
import { TbLogout } from "react-icons/tb";
import useAuthStore from "../src/stores/auth.store";
import useMediaUiStore from "../src/stores/media-ui.store";
import { Great_Vibes } from 'next/font/google'

const greatVibes = Great_Vibes({
  subsets: ['latin'],
  weight: '400',
})

export default function Topbar({ event_name }: { event_name: string }) {

    const { logout } = useAuthStore();
    const { downloadSelected, downloading, selectedIds, isSelectionMode, toggleSelectedMode } = useMediaUiStore();

    const handleDownload = () => {
        if (downloading || selectedIds.size === 0) return;

        downloadSelected();
    }

    return(
        <section className="fixed top-0 left-0 right-0 z-50 bg-white/95 backdrop-blur-md w-full">
            <div className="flex w-full items-center justify-around py-4">
                <p className={`text-3xl font-bold text-amber-700! justify-self-end ${greatVibes.className}`}>{event_name}</p>
                <div className='flex gap-x-2 justify-self-end items-center'>
                    <>
                        {isSelectionMode && selectedIds.size > 0 && (
                            <span>
                                {selectedIds.size} seleccionadas
                            </span>
                        )}
                    </>
                    <Button appearance='mate' color="purple" intensity={500} size='sm' onClick={toggleSelectedMode}> {isSelectionMode ? "Cancelar" : "Seleccionar"} </Button>
                    {isSelectionMode &&
                        <Button appearance='mate' color='purple' intensity={700} size='sm' onClick={handleDownload}> {downloading? "Descargando...": "Descargar"}</Button>
                    }
                    <Button appearance='mate' color="purple" intensity={700} size='sm' className="aspect-square"> <FaShare size={14}/> </Button>

                    {!isSelectionMode &&
                        <>
                            <Button appearance='mate' color="purple" intensity={700} size='sm' className="aspect-square"> <IoSettingsSharp size={14}/> </Button>
                            <Button appearance='outlined' color="amber" intensity={700} size='sm' className="aspect-square" style={{ color: '#5A463A' }} onClick={logout}> <TbLogout size={14}/> </Button>
                        </>
                    }
                    
                </div>
            </div>
        </section>
    )
}