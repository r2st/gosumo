export function SectionHeading({ eyebrow, title, subtitle, center = true }) {
  return (
    <div className={center ? 'mx-auto max-w-2xl text-center' : 'max-w-2xl'}>
      {eyebrow && (
        <span className="inline-block rounded-full bg-brand-50 px-3 py-1 text-sm font-semibold uppercase tracking-wide text-brand-600">
          {eyebrow}
        </span>
      )}
      <h2 className="mt-4 text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl">
        {title}
      </h2>
      {subtitle && <p className="mt-4 text-lg leading-relaxed text-slate-600">{subtitle}</p>}
    </div>
  )
}
