import { Icon } from '../icons.jsx'
import { stats } from '../data.js'

export default function Hero() {
  return (
    <section
      id="home"
      className="relative overflow-hidden bg-gradient-to-b from-brand-50 via-sky-50/40 to-white pt-28 pb-20 sm:pt-32 lg:pt-40"
    >
      {/* decorative blobs */}
      <div className="pointer-events-none absolute -right-24 -top-24 h-96 w-96 rounded-full bg-brand-200/40 blur-3xl" />
      <div className="pointer-events-none absolute -left-32 top-40 h-96 w-96 rounded-full bg-sky-200/40 blur-3xl" />

      <div className="relative mx-auto grid max-w-7xl items-center gap-12 px-4 sm:px-6 lg:grid-cols-2 lg:px-8">
        <div className="animate-fade-up">
          <span className="inline-flex items-center gap-2 rounded-full border border-brand-200 bg-white/70 px-4 py-1.5 text-sm font-medium text-brand-700 shadow-sm">
            <span className="flex h-2 w-2 rounded-full bg-brand-500" />
            NABH-accredited • Trusted since 2009
          </span>

          <h1 className="mt-6 text-4xl font-extrabold leading-tight tracking-tight text-slate-900 sm:text-5xl lg:text-6xl">
            Compassionate care for{' '}
            <span className="bg-gradient-to-r from-brand-600 to-sky-600 bg-clip-text text-transparent">
              every family
            </span>
          </h1>

          <p className="mt-5 max-w-xl text-lg leading-relaxed text-slate-600">
            From everyday check-ups to specialist consultations, HealthFirst brings
            expert doctors, modern diagnostics and round-the-clock support together —
            all under one trusted roof.
          </p>

          <div className="mt-8 flex flex-wrap gap-4">
            <a
              href="#book"
              className="inline-flex items-center gap-2 rounded-full bg-brand-600 px-7 py-3.5 text-base font-semibold text-white shadow-lg shadow-brand-600/20 transition hover:bg-brand-700 hover:shadow-xl"
            >
              <Icon name="calendar" className="h-5 w-5" />
              Book an Appointment
            </a>
            <a
              href="#packages"
              className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-7 py-3.5 text-base font-semibold text-slate-700 transition hover:border-brand-300 hover:text-brand-700"
            >
              View Health Packages
            </a>
          </div>

          <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-3 text-sm text-slate-500">
            <span className="inline-flex items-center gap-2">
              <Icon name="clock" className="h-4 w-4 text-brand-600" /> Open 7 days · 8am–10pm
            </span>
            <span className="inline-flex items-center gap-2">
              <Icon name="shield" className="h-4 w-4 text-brand-600" /> Cashless insurance accepted
            </span>
          </div>
        </div>

        {/* Hero visual card */}
        <div className="relative animate-fade-up [animation-delay:120ms]">
          <div className="relative mx-auto max-w-md rounded-3xl bg-white p-6 shadow-2xl shadow-slate-300/40 ring-1 ring-slate-100">
            <div className="flex items-center justify-between rounded-2xl bg-gradient-to-r from-brand-600 to-sky-600 p-5 text-white">
              <div>
                <p className="text-sm/relaxed opacity-90">Next available slot</p>
                <p className="text-xl font-bold">Today · 4:30 PM</p>
              </div>
              <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-white/20">
                <Icon name="calendar" className="h-7 w-7" />
              </span>
            </div>

            <div className="mt-5 space-y-3">
              {[
                { icon: 'heart', label: 'Cardiology Consult', sub: 'Dr. Ananya Sharma' },
                { icon: 'baby', label: 'Child Wellness', sub: 'Dr. Priya Menon' },
                { icon: 'flask', label: 'Full Body Lab Test', sub: 'Reports in 6 hrs' },
              ].map((row) => (
                <div
                  key={row.label}
                  className="flex items-center gap-3 rounded-2xl border border-slate-100 bg-slate-50/60 p-3"
                >
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-100 text-brand-700">
                    <Icon name={row.icon} className="h-6 w-6" />
                  </span>
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-slate-800">{row.label}</p>
                    <p className="text-xs text-slate-500">{row.sub}</p>
                  </div>
                  <Icon name="check" className="h-5 w-5 text-brand-500" />
                </div>
              ))}
            </div>

            <div className="mt-5 flex items-center gap-3 rounded-2xl bg-sky-50 p-3 text-sky-800">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-sky-600 text-white">
                <Icon name="chat" className="h-5 w-5" />
              </span>
              <p className="text-sm font-medium">
                Ask our AI assistant anything — 24×7 instant replies
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Stats bar */}
      <div className="relative mx-auto mt-16 max-w-6xl px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-3xl bg-slate-100 shadow-sm ring-1 ring-slate-100 sm:grid-cols-4">
          {stats.map((s) => (
            <div key={s.label} className="bg-white px-6 py-7 text-center">
              <p className="text-3xl font-extrabold text-brand-600">{s.value}</p>
              <p className="mt-1 text-sm font-medium text-slate-500">{s.label}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
