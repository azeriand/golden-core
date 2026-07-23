import { Great_Vibes } from 'next/font/google'

const greatVibes = Great_Vibes({
  subsets: ['latin'],
  weight: '400',
})

export default function SectionHeader({label, time}: {label: string, time: string}) {
    return(
        <header className="flex justify-between items center w-full">
            <p className={`text-2xl text-amber-700! ${greatVibes.className}`}>{label}</p>
            <p className={`text-xl text-amber-700! ${greatVibes.className}`}>{time}</p>
        </header>
    )
}