import { Icon } from '../icons.jsx'
import { testimonials } from '../data.js'
import { SectionHeading } from './Section.jsx'

export default function Testimonials() {
  return (
    <section id="testimonials" className="bg-slate-50 py-20 sm:py-24">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="Patient Stories"
          title="Trusted by thousands of families"
          subtitle="Real experiences from patients who chose HealthFirst for their care."
        />

        <div className="mt-14 grid gap-6 md:grid-cols-3">
          {testimonials.map((t) => (
            <figure
              key={t.name}
              className="flex flex-col rounded-2xl bg-white p-7 shadow-sm ring-1 ring-slate-100"
            >
              <div className="flex gap-0.5 text-amber-400">
                {Array.from({ length: t.rating }).map((_, i) => (
                  <Icon key={i} name="star" className="h-5 w-5 fill-amber-400" />
                ))}
              </div>
              <blockquote className="mt-4 flex-1 text-slate-600">“{t.text}”</blockquote>
              <figcaption className="mt-6 flex items-center gap-3 border-t border-slate-100 pt-5">
                <span className="flex h-11 w-11 items-center justify-center rounded-full bg-brand-100 font-bold text-brand-700">
                  {t.initials}
                </span>
                <div>
                  <p className="text-sm font-bold text-slate-900">{t.name}</p>
                  <p className="text-xs text-slate-500">{t.location}</p>
                </div>
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  )
}
