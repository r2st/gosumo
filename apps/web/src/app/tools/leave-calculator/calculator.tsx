'use client';

import { useState } from 'react';
import { ShareButtons } from '@/components/share-buttons';

const fmtInr = (n: number) =>
  '₹' + Math.round(n).toLocaleString('en-IN');

export function LeaveCalculator() {
  const [monthlySalary, setMonthlySalary] = useState('40000');
  const [leaveBalance, setLeaveBalance] = useState('18');
  const [annualQuota, setAnnualQuota] = useState('24');
  const [monthsWorked, setMonthsWorked] = useState('12');

  const salaryVal = parseFloat(monthlySalary) || 0;
  const balanceVal = parseFloat(leaveBalance) || 0;
  const quotaVal = parseFloat(annualQuota) || 0;
  const monthsVal = parseFloat(monthsWorked) || 0;

  const perDaySalary = salaryVal / 30;
  const encashment = perDaySalary * balanceVal;
  const accrued = (quotaVal / 12) * monthsVal;
  const exemptionLimit = 2500000; // ₹25 lakh u/s 10(10AA) for non-government employees
  const taxFree = Math.min(encashment, exemptionLimit);

  return (
    <div>
      <h1 className="text-3xl font-bold text-[var(--da-text)] mb-2" style={{ fontFamily: 'var(--da-font-display)' }}>
        Leave Encashment Calculator
      </h1>
      <p className="text-[var(--da-text-secondary)] mb-8">
        Calculate earned leave accrual and the cash value of your unused leave balance — no sign-up required.
      </p>

      <div className="space-y-6">
        <div className="p-6 rounded-xl border border-[var(--da-border)] bg-[var(--da-surface)]">
          <h2 className="text-sm font-medium text-[var(--da-text-secondary)] mb-4">Salary &amp; Leave Details</h2>
          <div className="space-y-4">
            <div className="flex items-center gap-4">
              <label className="text-sm text-[var(--da-text)] w-56">Monthly Salary (Basic + DA, ₹)</label>
              <input
                type="number"
                min={0}
                value={monthlySalary}
                onChange={(e) => setMonthlySalary(e.target.value)}
                className="w-32 px-3 py-2 rounded-md text-sm text-center"
              />
            </div>
            <div className="flex items-center gap-4">
              <label className="text-sm text-[var(--da-text)] w-56">Unused Leave Balance (days)</label>
              <input
                type="number"
                min={0}
                value={leaveBalance}
                onChange={(e) => setLeaveBalance(e.target.value)}
                className="w-32 px-3 py-2 rounded-md text-sm text-center"
              />
            </div>
            <div className="flex items-center gap-4">
              <label className="text-sm text-[var(--da-text)] w-56">Annual Leave Quota (days)</label>
              <input
                type="number"
                min={0}
                value={annualQuota}
                onChange={(e) => setAnnualQuota(e.target.value)}
                className="w-32 px-3 py-2 rounded-md text-sm text-center"
              />
            </div>
            <div className="flex items-center gap-4">
              <label className="text-sm text-[var(--da-text)] w-56">Months Worked This Year</label>
              <input
                type="number"
                min={0}
                max={12}
                value={monthsWorked}
                onChange={(e) => setMonthsWorked(e.target.value)}
                className="w-32 px-3 py-2 rounded-md text-sm text-center"
              />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="p-4 rounded-xl border border-[var(--da-border)] bg-[var(--da-surface)]">
            <p className="text-xs text-[var(--da-text-muted)] mb-1">Per-Day Salary</p>
            <p className="text-xl font-bold text-[var(--da-text)]">{fmtInr(perDaySalary)}</p>
          </div>
          <div className="p-4 rounded-xl border border-[var(--da-border)] bg-[var(--da-surface)]">
            <p className="text-xs text-[var(--da-text-muted)] mb-1">Encashment Value</p>
            <p className="text-xl font-bold text-[var(--da-gold)]">{fmtInr(encashment)}</p>
          </div>
          <div className="p-4 rounded-xl border border-[var(--da-border)] bg-[var(--da-surface)]">
            <p className="text-xs text-[var(--da-text-muted)] mb-1">Leave Accrued This Year</p>
            <p className="text-xl font-bold text-[var(--da-success)]">{accrued.toFixed(1)} days</p>
          </div>
        </div>

        <div className="p-6 rounded-xl border border-[var(--da-border)] bg-[var(--da-surface)]">
          <h2 className="text-sm font-medium text-[var(--da-text-secondary)] mb-3">How Leave Encashment Works</h2>
          <div className="text-sm text-[var(--da-text-secondary)] space-y-2">
            <p>
              <span className="font-mono text-[var(--da-text)]">Encashment = (monthly salary ÷ 30) × unused leave days</span>
            </p>
            <p>Most Indian employers compute per-day salary on Basic + DA over 30 days, though some use 26 working days — check your HR policy.</p>
            <p>On retirement or resignation, leave encashment up to ₹25 lakh is exempt from income tax under Section 10(10AA) for non-government employees. Your tax-free portion here: <span className="text-[var(--da-text)] font-medium">{fmtInr(taxFree)}</span>.</p>
            <p>Encashment received while still employed is fully taxable as salary.</p>
          </div>
        </div>

        <ShareButtons url="https://desk.doaide.com/tools/leave-calculator" title="Leave Encashment Calculator — Free tool by DoAide Desk" />

        <div className="p-6 rounded-xl border border-[var(--da-border)] bg-[var(--da-surface)] text-center">
          <p className="text-sm text-[var(--da-text-secondary)] mb-3">Running a team? Keep every client conversation in one inbox.</p>
          <a href="/register" className="inline-block px-6 py-2.5 rounded-lg bg-[var(--da-gold)] text-black font-medium text-sm hover:opacity-90 transition-opacity">Sign up free</a>
        </div>
      </div>
    </div>
  );
}
