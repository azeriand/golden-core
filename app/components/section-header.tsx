import { Cormorant_Garamond } from 'next/font/google'

const cormorantGaramond = Cormorant_Garamond({
  subsets: ['latin'],
})

export default function SectionHeader({label, time}: {label: string, time: string}) {
    return(
        <header className="flex justify-between items center w-full">
            <p className={`text-2xl text-amber-700! ${cormorantGaramond.className}`}>{label}</p>
            <p className={`text-xl text-amber-700! ${cormorantGaramond.className}`}>{time}</p>
        </header>
    )
}