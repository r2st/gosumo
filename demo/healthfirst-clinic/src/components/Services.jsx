import { Icon } from '../icons.jsx'
import { services } from '../data.js'
import { SectionHeading } from './Section.jsx'

export default function Services() {
  return (
    <section id="services" className="bg-white py-20 sm:py-24">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="Our Services"
          title="Specialist care across every department"
          subtitle="Whatever your family needs, our experienced doctors and modern facilities are here to help — with empathy and precision."
        />

        <div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {services.map((s) => (
            <div
              key={s.title}
              className="group rounded-2xl border border-slate-100 bg-white p-7 shadow-sm transition duration-300 hover:-translate-y-1 hover:border-brand-200 hover:shadow-xl"
            >
              <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-50 text-brand-600 transition group-hover:bg-brand-600 group-hover:text-white">
                <Icon name={s.icon} className="h-7 w-7" />
              </span>
              <h3 className="mt-5 text-lg font-bold text-slate-900">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{s.desc}</p>
              <a
                href="#book"
                className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-brand-600 opacity-0 transition group-hover:opacity-100"
              >
                Book now →
              </a>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
