import { Icon } from '../icons.jsx'
import { SectionHeading } from './Section.jsx'

const details = [
  { icon: 'pin', title: 'Visit Us', lines: ['HealthFirst Clinic, 24 MG Road', 'Indiranagar, Bengaluru 560038'] },
  { icon: 'phone', title: 'Call Us', lines: ['+91 80 4567 8900', '+91 98765 43210 (WhatsApp)'] },
  { icon: 'mail', title: 'Email Us', lines: ['care@healthfirst.in', 'appointments@healthfirst.in'] },
  { icon: 'clock', title: 'Hours', lines: ['Mon–Sun: 8:00 AM – 10:00 PM', 'Emergency: 24×7'] },
]

export default function Contact() {
  return (
    <section id="contact" className="bg-white py-20 sm:py-24">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="Get In Touch"
          title="We’re here whenever you need us"
          subtitle="Reach out for appointments, reports, or any questions — our team responds quickly across every channel."
        />

        <div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {details.map((d) => (
            <div
              key={d.title}
              className="rounded-2xl border border-slate-100 bg-slate-50/60 p-6 text-center transition hover:border-brand-200 hover:bg-white hover:shadow-lg"
            >
              <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-100 text-brand-600">
                <Icon name={d.icon} className="h-7 w-7" />
              </span>
              <h3 className="mt-4 font-bold text-slate-900">{d.title}</h3>
              {d.lines.map((line) => (
                <p key={line} className="mt-1 text-sm text-slate-600">
                  {line}
                </p>
              ))}
            </div>
          ))}
        </div>

        <div className="mt-10 overflow-hidden rounded-3xl border border-slate-100 shadow-sm">
          <iframe
            title="HealthFirst Clinic location"
            src="https://www.openstreetmap.org/export/embed.html?bbox=77.630%2C12.965%2C77.650%2C12.985&layer=mapnik&marker=12.975%2C77.640"
            className="h-72 w-full border-0"
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
          />
        </div>
      </div>
    </section>
  )
}
