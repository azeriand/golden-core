import { Button, Card } from "azeriand-library"
import { IoSettingsSharp } from "react-icons/io5";
import { Great_Vibes } from 'next/font/google'

const greatVibes = Great_Vibes({
  subsets: ['latin'],
  weight: '400',
})

export default function HomeTopLayout({ event_name, event_date }: { event_name: string, event_date: string }) {
    return (
        <article className='flex flex-col items-center w-full gap-y-3'>
            <img src="https://img.magnific.com/free-photo/golden-wedding-rings-white-rose-from-wedding-bouquet_8353-10467.jpg?semt=ais_hybrid&w=740&q=80" alt="Default wedding image" className="w-full h-auto rounded-t-2xl" />
            <section className='flex flex-col items-center pt-4'>
                <h1 className={`text-2xl font-semibold ${greatVibes.className} text-purple-700`}>{event_name}</h1>
                <p className={`text-2xl font-bold ${greatVibes.className} text-purple-500`}>{event_date}</p>
            </section>
            <section className='flex justify-between w-full'>
                <Button appearance='mate' size="sm" color="amber" intensity={700} className="rounded-md">Compartir enlace</Button>
                <div className="flex gap-x-2">
                <Button appearance='mate' size='sm' color="purple" intensity={700} className="rounded-md mt-4" icon={<IoSettingsSharp size={16}/>}/>
                <Button appearance="mate" size='sm' color='purple' intensity={700}>Seleccionar</Button>
                </div>
            </section>
            <hr className='w-full border-t border-stone-300 p-0 m-0'/>
        </article>
    )
}