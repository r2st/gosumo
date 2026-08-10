import { Icon } from '../icons.jsx'
import { doctors } from '../data.js'
import { SectionHeading } from './Section.jsx'

export default function Doctors() {
  return (
    <section id="doctors" className="bg-slate-50 py-20 sm:py-24">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="Meet Our Doctors"
          title="Experienced specialists you can trust"
          subtitle="Our consultants combine decades of clinical expertise with a genuinely caring approach to every patient."
        />

        <div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {doctors.map((d) => (
            <div
              key={d.name}
              className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-100 transition duration-300 hover:-translate-y-1 hover:shadow-xl"
            >
              <div className={`relative flex h-40 items-center justify-center bg-gradient-to-br ${d.color}`}>
                <span className="flex h-24 w-24 items-center justify-center rounded-full bg-white/15 text-3xl font-extrabold text-white ring-4 ring-white/20 backdrop-blur">
                  {d.initials}
                </span>
              </div>
              <div className="p-5">
                <h3 className="text-lg font-bold text-slate-900">{d.name}</h3>
                <p className="text-sm font-semibold text-brand-600">{d.specialty}</p>
                <p className="mt-2 text-xs leading-relaxed text-slate-500">{d.qualifications}</p>
                <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-4">
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500">
                    <Icon name="award" className="h-4 w-4 text-brand-500" />
                    {d.experience}
                  </span>
                  <a
                    href="#book"
                    className="rounded-full bg-brand-50 px-3.5 py-1.5 text-xs font-semibold text-brand-700 transition hover:bg-brand-600 hover:text-white"
                  >
                    Book
                  </a>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
