'use client';

import { useState } from 'react';
import { ShareButtons } from '@/components/share-buttons';

const fmtInr = (n: number) =>
  '₹' + Math.round(n).toLocaleString('en-IN');

type Slab = { upTo: number; rate: number };

const NEW_REGIME_SLABS: Slab[] = [
  { upTo: 400000, rate: 0 },
  { upTo: 800000, rate: 0.05 },
  { upTo: 1200000, rate: 0.1 },
  { upTo: 1600000, rate: 0.15 },
  { upTo: 2000000, rate: 0.2 },
  { upTo: 2400000, rate: 0.25 },
  { upTo: Infinity, rate: 0.3 },
];

const OLD_REGIME_SLABS: Slab[] = [
  { upTo: 250000, rate: 0 },
  { upTo: 500000, rate: 0.05 },
  { upTo: 1000000, rate: 0.2 },
  { upTo: Infinity, rate: 0.3 },
];

function slabTax(income: number, slabs: Slab[]): number {
  let tax = 0;
  let prev = 0;
  for (const slab of slabs) {
    if (income <= prev) break;
    tax += (Math.min(income, slab.upTo) - prev) * slab.rate;
    prev = slab.upTo;
  }
  return tax;
}

export function TdsCalculator() {
  const [annualSalary, setAnnualSalary] = useState('1200000');
  const [regime, setRegime] = useState<'new' | 'old'>('new');
  const [deductions, setDeductions] = useState('150000');

  const salaryVal = parseFloat(annualSalary) || 0;
  const deductionsVal = parseFloat(deductions) || 0;

  const stdDeduction = regime === 'new' ? 75000 : 50000;
  const taxable = Math.max(0, salaryVal - stdDeduction - (regime === 'old' ? deductionsVal : 0));

  let tax = slabTax(taxable, regime === 'new' ? NEW_REGIME_SLABS : OLD_REGIME_SLABS);

  // Section 87A rebate (FY 2025-26)
  if (regime === 'new' && taxable <= 1200000) tax = Math.max(0, tax - 60000);
  if (regime === 'old' && taxable <= 500000) tax = Math.max(0, tax - 12500);

  const cess = tax * 0.04;
  const totalTax = tax + cess;
  const monthlyTds = totalTax / 12;
  const effectiveRate = salaryVal > 0 ? (totalTax / salaryVal) * 100 : 0;

  return (
    <div>
      <h1 className="text-3xl font-bold text-[var(--da-text)] mb-2" style={{ fontFamily: 'var(--da-font-display)' }}>
        TDS on Salary Calculator
      </h1>
      <p className="text-[var(--da-text-secondary)] mb-8">
        Estimate monthly TDS deduction from salary for FY 2025-26 under the new or old tax regime — no sign-up required.
      </p>

      <div className="space-y-6">
        <div className="p-6 rounded-xl border border-[var(--da-border)] bg-[var(--da-surface)]">
          <h2 className="text-sm font-medium text-[var(--da-text-secondary)] mb-4">Income Details</h2>
          <div className="space-y-4">
            <div className="flex items-center gap-4">
              <label className="text-sm text-[var(--da-text)] w-56">Annual Gross Salary (₹)</label>
              <input
                type="number"
                min={0}
                value={annualSalary}
                onChange={(e) => setAnnualSalary(e.target.value)}
                className="w-36 px-3 py-2 rounded-md text-sm text-center"
              />
            </div>
            <div className="flex items-center gap-4">
              <label className="text-sm text-[var(--da-text)] w-56">Tax Regime</label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setRegime('new')}
                  className={`px-4 py-2 rounded-md text-sm border transition-colors ${regime === 'new' ? 'bg-[var(--da-gold)] text-black border-[var(--da-gold)]' : 'border-[var(--da-border)] text-[var(--da-text-secondary)]'}`}
                >
                  New Regime
                </button>
                <button
                  type="button"
                  onClick={() => setRegime('old')}
                  className={`px-4 py-2 rounded-md text-sm border transition-colors ${regime === 'old' ? 'bg-[var(--da-gold)] text-black border-[var(--da-gold)]' : 'border-[var(--da-border)] text-[var(--da-text-secondary)]'}`}
                >
                  Old Regime
                </button>
              </div>
            </div>
            {regime === 'old' && (
              <div className="flex items-center gap-4">
                <label className="text-sm text-[var(--da-text)] w-56">Deductions (80C, 80D, HRA etc., ₹)</label>
                <input
                  type="number"
                  min={0}
                  value={deductions}
                  onChange={(e) => setDeductions(e.target.value)}
                  className="w-36 px-3 py-2 rounded-md text-sm text-center"
                />
              </div>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="p-4 rounded-xl border border-[var(--da-border)] bg-[var(--da-surface)]">
            <p className="text-xs text-[var(--da-text-muted)] mb-1">Taxable Income</p>
            <p className="text-xl font-bold text-[var(--da-text)]">{fmtInr(taxable)}</p>
          </div>
          <div className="p-4 rounded-xl border border-[var(--da-border)] bg-[var(--da-surface)]">
            <p className="text-xs text-[var(--da-text-muted)] mb-1">Annual Tax + Cess</p>
            <p className="text-xl font-bold text-[var(--da-error)]">{fmtInr(totalTax)}</p>
          </div>
          <div className="p-4 rounded-xl border border-[var(--da-border)] bg-[var(--da-surface)]">
            <p className="text-xs text-[var(--da-text-muted)] mb-1">Monthly TDS</p>
            <p className="text-xl font-bold text-[var(--da-gold)]">{fmtInr(monthlyTds)}</p>
          </div>
          <div className="p-4 rounded-xl border border-[var(--da-border)] bg-[var(--da-surface)]">
            <p className="text-xs text-[var(--da-text-muted)] mb-1">Effective Rate</p>
            <p className="text-xl font-bold text-[var(--da-success)]">{effectiveRate.toFixed(1)}%</p>
          </div>
        </div>

        <div className="p-6 rounded-xl border border-[var(--da-border)] bg-[var(--da-surface)]">
          <h2 className="text-sm font-medium text-[var(--da-text-secondary)] mb-3">New Regime Slabs (FY 2025-26)</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--da-border)]">
                  <th className="text-left py-2 text-[var(--da-text-muted)]">Income Slab</th>
                  <th className="text-left py-2 text-[var(--da-text-muted)]">Rate</th>
                </tr>
              </thead>
              <tbody className="text-[var(--da-text)]">
                {[
                  { slab: 'Up to ₹4,00,000', rate: 'Nil' },
                  { slab: '₹4,00,001 – ₹8,00,000', rate: '5%' },
                  { slab: '₹8,00,001 – ₹12,00,000', rate: '10%' },
                  { slab: '₹12,00,001 – ₹16,00,000', rate: '15%' },
                  { slab: '₹16,00,001 – ₹20,00,000', rate: '20%' },
                  { slab: '₹20,00,001 – ₹24,00,000', rate: '25%' },
                  { slab: 'Above ₹24,00,000', rate: '30%' },
                ].map((row) => (
                  <tr key={row.slab} className="border-b border-[var(--da-border)]">
                    <td className="py-2">{row.slab}</td>
                    <td className="py-2 font-mono">{row.rate}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-[var(--da-text-muted)] mt-3">
            Standard deduction: ₹75,000 (new regime) / ₹50,000 (old regime). Section 87A rebate makes income up to ₹12 lakh effectively tax-free in the new regime. 4% health &amp; education cess applies. Estimates only — consult your tax advisor.
          </p>
        </div>

        <ShareButtons url="https://desk.doaide.com/tools/tds-calculator" title="TDS on Salary Calculator — Free tool by DoAide Desk" />

        <div className="p-6 rounded-xl border border-[var(--da-border)] bg-[var(--da-surface)] text-center">
          <p className="text-sm text-[var(--da-text-secondary)] mb-3">Spend less time on admin — automate your customer support with AI.</p>
          <a href="/register" className="inline-block px-6 py-2.5 rounded-lg bg-[var(--da-gold)] text-black font-medium text-sm hover:opacity-90 transition-opacity">Sign up free</a>
        </div>
      </div>
    </div>
  );
}
