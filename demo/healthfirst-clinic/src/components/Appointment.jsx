import { useState } from 'react'
import { Icon } from '../icons.jsx'
import { departments, doctors } from '../data.js'

const initial = { name: '', phone: '', department: '', doctor: '', date: '', time: '', notes: '' }

export default function Appointment() {
  const [form, setForm] = useState(initial)
  const [submitted, setSubmitted] = useState(false)

  const update = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }))

  const onSubmit = (e) => {
    e.preventDefault()
    setSubmitted(true)
  }

  return (
    <section id="book" className="relative overflow-hidden bg-slate-900 py-20 sm:py-24">
      <div className="pointer-events-none absolute -right-20 top-0 h-96 w-96 rounded-full bg-brand-600/20 blur-3xl" />
      <div className="pointer-events-none absolute -left-20 bottom-0 h-96 w-96 rounded-full bg-sky-600/20 blur-3xl" />

      <div className="relative mx-auto grid max-w-7xl items-center gap-12 px-4 sm:px-6 lg:grid-cols-2 lg:px-8">
        <div className="text-white">
          <span className="inline-block rounded-full bg-white/10 px-3 py-1 text-sm font-semibold uppercase tracking-wide text-brand-200">
            Book an Appointment
          </span>
          <h2 className="mt-4 text-3xl font-extrabold tracking-tight sm:text-4xl">
            Your health can’t wait. Book in under a minute.
          </h2>
          <p className="mt-4 max-w-md text-lg leading-relaxed text-slate-300">
            Choose your department, pick a convenient time, and our team will confirm
            your slot instantly on WhatsApp.
          </p>

          <ul className="mt-8 space-y-4">
            {[
              { icon: 'clock', text: 'Same-day appointments available' },
              { icon: 'phone', text: 'Instant WhatsApp confirmation' },
              { icon: 'shield', text: 'Your data is private & secure' },
            ].map((f) => (
              <li key={f.text} className="flex items-center gap-3 text-slate-200">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/10 text-brand-200">
                  <Icon name={f.icon} className="h-5 w-5" />
                </span>
                <span className="font-medium">{f.text}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-3xl bg-white p-6 shadow-2xl sm:p-8">
          {submitted ? (
            <div className="flex flex-col items-center py-10 text-center animate-slide-up">
              <span className="flex h-16 w-16 items-center justify-center rounded-full bg-brand-100 text-brand-600">
                <Icon name="check" className="h-9 w-9" />
              </span>
              <h3 className="mt-5 text-2xl font-bold text-slate-900">Appointment Requested!</h3>
              <p className="mt-2 max-w-sm text-slate-600">
                Thank you, <span className="font-semibold">{form.name || 'there'}</span>. Our care
                team will confirm your{' '}
                <span className="font-semibold">{form.department || 'appointment'}</span> slot on
                WhatsApp shortly.
              </p>
              <button
                onClick={() => {
                  setForm(initial)
                  setSubmitted(false)
                }}
                className="mt-6 rounded-full bg-brand-600 px-6 py-3 text-sm font-semibold text-white transition hover:bg-brand-700"
              >
                Book Another
              </button>
            </div>
          ) : (
            <form onSubmit={onSubmit} className="space-y-4">
              <h3 className="text-xl font-bold text-slate-900">Request your slot</h3>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Full Name" required>
                  <input
                    type="text"
                    required
                    value={form.name}
                    onChange={update('name')}
                    placeholder="e.g. Rohan Gupta"
                    className={inputCls}
                  />
                </Field>
                <Field label="Phone Number" required>
                  <input
                    type="tel"
                    required
                    pattern="[0-9+\- ]{7,15}"
                    value={form.phone}
                    onChange={update('phone')}
                    placeholder="+91 98765 43210"
                    className={inputCls}
                  />
                </Field>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Department" required>
                  <select required value={form.department} onChange={update('department')} className={inputCls}>
                    <option value="">Select department</option>
                    {departments.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Preferred Doctor">
                  <select value={form.doctor} onChange={update('doctor')} className={inputCls}>
                    <option value="">Any available</option>
                    {doctors.map((d) => (
                      <option key={d.name} value={d.name}>
                        {d.name} — {d.specialty}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Preferred Date" required>
                  <input type="date" required value={form.date} onChange={update('date')} className={inputCls} />
                </Field>
                <Field label="Preferred Time" required>
                  <select required value={form.time} onChange={update('time')} className={inputCls}>
                    <option value="">Select time</option>
                    {['09:00 AM', '11:00 AM', '01:00 PM', '03:30 PM', '05:00 PM', '07:00 PM'].map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              <Field label="Notes (optional)">
                <textarea
                  rows={3}
                  value={form.notes}
                  onChange={update('notes')}
                  placeholder="Briefly describe your symptoms or concern"
                  className={inputCls}
                />
              </Field>

              <button
                type="submit"
                className="w-full rounded-full bg-brand-600 px-6 py-3.5 text-base font-semibold text-white shadow-lg shadow-brand-600/20 transition hover:bg-brand-700"
              >
                Confirm Appointment
              </button>
              <p className="text-center text-xs text-slate-400">
                By booking, you agree to our privacy policy. This is a demo form.
              </p>
            </form>
          )}
        </div>
      </div>
    </section>
  )
}

const inputCls =
  'w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-800 outline-none transition focus:border-brand-500 focus:bg-white focus:ring-2 focus:ring-brand-100'

function Field({ label, required, children }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-slate-700">
        {label}
        {required && <span className="text-brand-600"> *</span>}
      </span>
      {children}
    </label>
  )
}
