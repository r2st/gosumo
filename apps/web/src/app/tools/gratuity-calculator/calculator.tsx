'use client';

import { useState } from 'react';
import { ShareButtons } from '@/components/share-buttons';

const fmtInr = (n: number) =>
  '₹' + Math.round(n).toLocaleString('en-IN');

export function GratuityCalculator() {
  const [monthlySalary, setMonthlySalary] = useState('50000');
  const [years, setYears] = useState('7');
  const [months, setMonths] = useState('4');

  const salaryVal = parseFloat(monthlySalary) || 0;
  const yearsVal = parseInt(years, 10) || 0;
  const monthsVal = parseInt(months, 10) || 0;

  // Payment of Gratuity Act, 1972: service of 6 months or more rounds up to a full year
  const serviceYears = monthsVal >= 6 ? yearsVal + 1 : yearsVal;
  const eligible = yearsVal > 4 || (yearsVal === 4 && monthsVal >= 6);

  const gratuity = eligible ? (15 * salaryVal * serviceYears) / 26 : 0;
  const taxFreeLimit = 2000000; // ₹20 lakh exemption u/s 10(10)
  const taxFree = Math.min(gratuity, taxFreeLimit);
  const taxable = Math.max(0, gratuity - taxFreeLimit);

  return (
    <div>
      <h1 className="text-3xl font-bold text-[var(--da-text)] mb-2" style={{ fontFamily: 'var(--da-font-display)' }}>
        Gratuity Calculator
      </h1>
      <p className="text-[var(--da-text-secondary)] mb-8">
        Calculate gratuity under the Payment of Gratuity Act, 1972 from your last drawn salary and years of service — no sign-up required.
      </p>

      <div className="space-y-6">
        <div className="p-6 rounded-xl border border-[var(--da-border)] bg-[var(--da-surface)]">
          <h2 className="text-sm font-medium text-[var(--da-text-secondary)] mb-4">Salary &amp; Service</h2>
          <div className="space-y-4">
            <div className="flex items-center gap-4">
              <label className="text-sm text-[var(--da-text)] w-56">Last Drawn Monthly Salary (Basic + DA, ₹)</label>
              <input
                type="number"
                min={0}
                value={monthlySalary}
                onChange={(e) => setMonthlySalary(e.target.value)}
                className="w-32 px-3 py-2 rounded-md text-sm text-center"
              />
            </div>
            <div className="flex items-center gap-4">
              <label className="text-sm text-[var(--da-text)] w-56">Years of Service</label>
              <input
                type="number"
                min={0}
                value={years}
                onChange={(e) => setYears(e.target.value)}
                className="w-32 px-3 py-2 rounded-md text-sm text-center"
              />
            </div>
            <div className="flex items-center gap-4">
              <label className="text-sm text-[var(--da-text)] w-56">Additional Months</label>
              <input
                type="number"
                min={0}
                max={11}
                value={months}
                onChange={(e) => setMonths(e.target.value)}
                className="w-32 px-3 py-2 rounded-md text-sm text-center"
              />
            </div>
          </div>
        </div>

        {!eligible && (
          <div className="p-4 rounded-xl border border-[var(--da-border)] bg-[var(--da-surface)]">
            <p className="text-sm text-[var(--da-warning)]">
              Gratuity is payable only after 5 years of continuous service (4 years and 6 months counts as 5 under the rounding rule used by most employers).
            </p>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="p-4 rounded-xl border border-[var(--da-border)] bg-[var(--da-surface)]">
            <p className="text-xs text-[var(--da-text-muted)] mb-1">Gratuity Payable</p>
            <p className="text-xl font-bold text-[var(--da-gold)]">{fmtInr(gratuity)}</p>
          </div>
          <div className="p-4 rounded-xl border border-[var(--da-border)] bg-[var(--da-surface)]">
            <p className="text-xs text-[var(--da-text-muted)] mb-1">Tax-Free Portion</p>
            <p className="text-xl font-bold text-[var(--da-success)]">{fmtInr(taxFree)}</p>
          </div>
          <div className="p-4 rounded-xl border border-[var(--da-border)] bg-[var(--da-surface)]">
            <p className="text-xs text-[var(--da-text-muted)] mb-1">Taxable Portion</p>
            <p className="text-xl font-bold text-[var(--da-error)]">{fmtInr(taxable)}</p>
          </div>
        </div>

        <div className="p-6 rounded-xl border border-[var(--da-border)] bg-[var(--da-surface)]">
          <h2 className="text-sm font-medium text-[var(--da-text-secondary)] mb-3">How Gratuity Is Calculated</h2>
          <div className="text-sm text-[var(--da-text-secondary)] space-y-2">
            <p>
              <span className="font-mono text-[var(--da-text)]">Gratuity = (15 × last drawn salary × years of service) ÷ 26</span>
            </p>
            <p>Last drawn salary means Basic + Dearness Allowance. 26 represents working days in a month, and 15 is half a month&apos;s salary per completed year.</p>
            <p>Service of 6 months or more in the final year rounds up to a full year — 7 years 4 months counts as 7 years, while 7 years 7 months counts as 8 years.</p>
            <p>Gratuity up to ₹20 lakh is exempt from income tax under Section 10(10) for employees covered by the Payment of Gratuity Act.</p>
          </div>
        </div>

        <ShareButtons url="https://desk.doaide.com/tools/gratuity-calculator" title="Gratuity Calculator — Free tool by DoAide Desk" />

        <div className="p-6 rounded-xl border border-[var(--da-border)] bg-[var(--da-surface)] text-center">
          <p className="text-sm text-[var(--da-text-secondary)] mb-3">Managing an HR or support team? Automate your client conversations too.</p>
          <a href="/register" className="inline-block px-6 py-2.5 rounded-lg bg-[var(--da-gold)] text-black font-medium text-sm hover:opacity-90 transition-opacity">Sign up free</a>
        </div>
      </div>
    </div>
  );
}
