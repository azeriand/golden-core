"use client"
import { Button } from "azeriand-library"
import { IoCloseOutline } from "react-icons/io5";
import { MdOutlineRadioButtonUnchecked, MdOutlineCheckCircleOutline } from "react-icons/md";
import { Great_Vibes } from 'next/font/google'
import useMediaUiStore from "../src/stores/media-ui.store";

const greatVibes = Great_Vibes({
  subsets: ['latin'],
  weight: '400',
})

export default function HomeTopLayout({ event_name, event_date, visibleMediaIds }: { event_name: string, event_date: string, visibleMediaIds: number[] }) {

    const { downloadSelected, downloading, selectedIds, isSelectionMode, toggleSelectedMode, selectAll, deselectAll } = useMediaUiStore();

    const allSelected = visibleMediaIds.length > 0 && visibleMediaIds.every((id) => selectedIds.has(id));

    const handleSelectAllToggle = () => {
        if (allSelected) {
            deselectAll();
        } else {
            selectAll(visibleMediaIds);
        }
    };

    const handleDownload = () => {
        if (downloading || selectedIds.size === 0) return;
        downloadSelected();
    }

    return (
        <>
            <img
                src="https://img.magnific.com/free-photo/golden-wedding-rings-white-rose-from-wedding-bouquet_8353-10467.jpg?semt=ais_hybrid&w=740&q=80"
                alt="Imagen del evento"
                className="w-full h-auto rounded-t-2xl"
            />

            <div className="bg-[#FFFCF8]/95 backdrop-blur-md w-full px-6 py-3">
                <div className="flex flex-col items-center gap-y-1">
                    <h1 className={`text-2xl font-semibold ${greatVibes.className} text-purple-700`}>{event_name}</h1>
                    <p className={`text-2xl font-bold ${greatVibes.className} text-purple-500`}>{event_date}</p>
                    <hr className='w-full border-t border-stone-300 mt-2' />
                    <div className="flex w-full justify-end mt-4 -mb-3 gap-x-2">
                        {!isSelectionMode && (
                            <Button appearance='mate' color="purple" intensity={200} size='sm' className="py-2! text-xs! rounded-xl! border-purple-200!" style={{ color: '#9D7BD6' }} onClick={toggleSelectedMode}>
                                Seleccionar
                            </Button>
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
        </>
    )
}
