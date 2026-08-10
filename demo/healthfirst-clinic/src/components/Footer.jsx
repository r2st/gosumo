import { Icon } from '../icons.jsx'

const cols = [
  {
    title: 'Departments',
    links: ['General Medicine', 'Cardiology', 'Pediatrics', 'Orthopedics', 'Gynecology'],
  },
  {
    title: 'Quick Links',
    links: ['Book Appointment', 'Health Packages', 'Our Doctors', 'Lab Reports', 'Insurance'],
  },
  {
    title: 'Support',
    links: ['Contact Us', 'Patient Rights', 'Privacy Policy', 'Terms of Service', 'Careers'],
  },
]

export default function Footer() {
  return (
    <footer className="bg-slate-950 text-slate-400">
      <div className="mx-auto max-w-7xl px-4 py-14 sm:px-6 lg:px-8">
        <div className="grid gap-10 md:grid-cols-2 lg:grid-cols-5">
          <div className="lg:col-span-2">
            <div className="flex items-center gap-2.5">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-600 text-white">
                <Icon name="shield" className="h-6 w-6" />
              </span>
              <span className="text-lg font-extrabold tracking-tight text-white">
                Health<span className="text-brand-400">First</span>
              </span>
            </div>
            <p className="mt-4 max-w-sm text-sm leading-relaxed">
              A trusted multispeciality clinic bringing compassionate, accessible
              healthcare to families across India since 2009.
            </p>
            <div className="mt-5 flex gap-3">
              {['phone', 'mail', 'pin'].map((i) => (
                <span
                  key={i}
                  className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/5 text-slate-300 transition hover:bg-brand-600 hover:text-white"
                >
                  <Icon name={i} className="h-5 w-5" />
                </span>
              ))}
            </div>
          </div>

          {cols.map((c) => (
            <div key={c.title}>
              <h4 className="text-sm font-bold uppercase tracking-wide text-white">{c.title}</h4>
              <ul className="mt-4 space-y-2.5">
                {c.links.map((l) => (
                  <li key={l}>
                    <a href="#" className="text-sm transition hover:text-brand-400">
                      {l}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 flex flex-col items-center justify-between gap-4 border-t border-white/10 pt-7 sm:flex-row">
          <p className="text-xs text-slate-500">
            © {new Date().getFullYear()} HealthFirst Clinic. All rights reserved. This is a demo website.
          </p>

          {/* GoSumo branding badge */}
          <a
            href="https://gosumo.ai"
            target="_blank"
            rel="noreferrer"
            className="group inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-slate-300 transition hover:border-brand-400/40 hover:bg-white/10"
          >
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-brand-500 to-sky-500 text-[11px] font-extrabold text-white">
              GS
            </span>
            Powered by{' '}
            <span className="font-bold text-white transition group-hover:text-brand-300">GoSumo</span>
          </a>
        </div>
      </div>
    </footer>
  )
}
