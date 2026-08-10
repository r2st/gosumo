import { Icon } from '../icons.jsx'
import { packages } from '../data.js'
import { formatINR } from '../utils.js'
import { SectionHeading } from './Section.jsx'

export default function HealthPackages() {
  return (
    <section id="packages" className="bg-white py-20 sm:py-24">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="Health Packages"
          title="Preventive check-ups that fit every budget"
          subtitle="Transparent pricing, no hidden charges. All packages include NABL-certified lab tests and a doctor consultation."
        />

        <div className="mt-14 grid items-stretch gap-6 lg:grid-cols-3">
          {packages.map((p) => (
            <div
              key={p.name}
              className={`relative flex flex-col rounded-3xl p-7 transition duration-300 ${
                p.highlight
                  ? 'bg-gradient-to-b from-brand-600 to-brand-700 text-white shadow-2xl shadow-brand-600/30 lg:-mt-4 lg:mb-4'
                  : 'border border-slate-200 bg-white text-slate-800 shadow-sm hover:shadow-lg'
              }`}
            >
              {p.highlight && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-sky-500 px-4 py-1 text-xs font-bold uppercase tracking-wide text-white shadow">
                  Most Popular
                </span>
              )}

              <div className="flex items-center justify-between">
                <h3 className={`text-lg font-bold ${p.highlight ? 'text-white' : 'text-slate-900'}`}>
                  {p.name}
                </h3>
                <span
                  className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                    p.highlight ? 'bg-white/20 text-white' : 'bg-brand-50 text-brand-700'
                  }`}
                >
                  {p.tests}
                </span>
              </div>

              <div className="mt-5 flex items-end gap-1">
                <span className={`text-sm font-semibold ${p.highlight ? 'text-white/80' : 'text-slate-400'}`}>
                  ₹
                </span>
                <span className={`text-4xl font-extrabold ${p.highlight ? 'text-white' : 'text-slate-900'}`}>
                  {formatINR(p.price)}
                </span>
                <span className={`mb-1 text-sm ${p.highlight ? 'text-white/70' : 'text-slate-400'}`}>
                  /{p.cadence}
                </span>
              </div>

              <ul className="mt-6 flex-1 space-y-3">
                {p.features.map((f) => (
                  <li key={f} className="flex items-start gap-2.5 text-sm">
                    <Icon
                      name="check"
                      className={`mt-0.5 h-4 w-4 shrink-0 ${p.highlight ? 'text-sky-200' : 'text-brand-500'}`}
                    />
                    <span className={p.highlight ? 'text-white/90' : 'text-slate-600'}>{f}</span>
                  </li>
                ))}
              </ul>

              <a
                href="#book"
                className={`mt-7 rounded-full px-6 py-3 text-center text-sm font-semibold transition ${
                  p.highlight
                    ? 'bg-white text-brand-700 hover:bg-brand-50'
                    : 'bg-brand-600 text-white hover:bg-brand-700'
                }`}
              >
                Book This Package
              </a>
            </div>
          ))}
        </div>

        <p className="mt-8 text-center text-sm text-slate-500">
          Need a custom corporate or family plan?{' '}
          <a href="#contact" className="font-semibold text-brand-600 hover:underline">
            Talk to our care team →
          </a>
        </p>
      </div>
    </section>
  )
}
