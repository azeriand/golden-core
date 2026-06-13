import { Button } from "azeriand-library"
import { FaShare } from "react-icons/fa"
import { IoSettingsSharp } from "react-icons/io5";
import { Great_Vibes } from 'next/font/google'

const greatVibes = Great_Vibes({
  subsets: ['latin'],
  weight: '400',
})

export default function Topbar({ event_name }: { event_name: string }) {

    return(
        <section className='flex justify-between items-center w-full'>
            <p className={`text-3xl font-bold text-amber-700! ${greatVibes.className}`}>{event_name}</p>
            <div className='flex gap-x-2 h-full'>
                <Button appearance='mate' color="purple" intensity={700} size='sm'> <FaShare size={16}/> </Button>
                <Button appearance='mate' color="purple" intensity={700} size='sm'> <IoSettingsSharp size={16}/> </Button>
                <Button appearance='mate' color="purple" intensity={700} size='sm'> Seleccionar </Button>
            </div>
        </section>
    )
}