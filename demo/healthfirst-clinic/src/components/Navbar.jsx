import { useEffect, useState } from 'react'
import { Icon } from '../icons.jsx'

const links = [
  { href: '#services', label: 'Services' },
  { href: '#doctors', label: 'Doctors' },
  { href: '#packages', label: 'Packages' },
  { href: '#testimonials', label: 'Reviews' },
  { href: '#contact', label: 'Contact' },
]

export default function Navbar() {
  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <header
      className={`fixed inset-x-0 top-0 z-40 transition-all duration-300 ${
        scrolled ? 'bg-white/90 backdrop-blur-md shadow-sm' : 'bg-transparent'
      }`}
    >
      <nav className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6 lg:px-8">
        <a href="#home" className="flex items-center gap-2.5">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-600 text-white shadow-sm">
            <Icon name="shield" className="h-6 w-6" />
          </span>
          <span className="flex flex-col leading-tight">
            <span className="text-lg font-extrabold tracking-tight text-slate-900">
              Health<span className="text-brand-600">First</span>
            </span>
            <span className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
              Multispeciality Clinic
            </span>
          </span>
        </a>

        <div className="hidden items-center gap-8 md:flex">
          {links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="text-sm font-medium text-slate-600 transition hover:text-brand-600"
            >
              {l.label}
            </a>
          ))}
          <a
            href="#book"
            className="rounded-full bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700 hover:shadow-md"
          >
            Book Appointment
          </a>
        </div>

        <button
          className="rounded-lg p-2 text-slate-700 md:hidden"
          onClick={() => setOpen((v) => !v)}
          aria-label="Toggle menu"
        >
          <Icon name={open ? 'close' : 'menu'} className="h-6 w-6" />
        </button>
      </nav>

      {open && (
        <div className="border-t border-slate-100 bg-white px-4 pb-4 pt-2 md:hidden">
          {links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              onClick={() => setOpen(false)}
              className="block rounded-lg px-3 py-2.5 text-sm font-medium text-slate-700 hover:bg-brand-50"
            >
              {l.label}
            </a>
          ))}
          <a
            href="#book"
            onClick={() => setOpen(false)}
            className="mt-2 block rounded-full bg-brand-600 px-5 py-3 text-center text-sm font-semibold text-white"
          >
            Book Appointment
          </a>
        </div>
      )}
    </header>
  )
}
