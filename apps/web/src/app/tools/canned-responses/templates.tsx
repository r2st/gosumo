'use client';

import { useState } from 'react';
import { ShareButtons } from '@/components/share-buttons';

const CATEGORIES = [
  {
    name: 'Acknowledgement',
    templates: [
      { title: 'Ticket Received', body: 'Hi {customer_name},\n\nThank you for reaching out. We have received your request (Ticket #{ticket_id}) and our team is reviewing it.\n\nWe aim to respond within {sla_hours} hours. If this is urgent, please reply to this message and we will prioritize it.\n\nBest regards,\n{agent_name}' },
      { title: 'Escalation Acknowledgement', body: 'Hi {customer_name},\n\nYour ticket #{ticket_id} has been escalated to our senior support team. They will review your case and get back to you within {sla_hours} hours.\n\nWe understand this has been frustrating and appreciate your patience.\n\nBest regards,\n{agent_name}' },
    ],
  },
  {
    name: 'Status Update',
    templates: [
      { title: 'In Progress', body: 'Hi {customer_name},\n\nQuick update on your ticket #{ticket_id} — our team is actively working on this. We have identified the issue and are implementing a fix.\n\nWe will update you as soon as it is resolved. Expected timeline: {timeline}.\n\nThank you for your patience,\n{agent_name}' },
      { title: 'Waiting for Info', body: 'Hi {customer_name},\n\nTo help resolve your ticket #{ticket_id}, we need a bit more information:\n\n- {question_1}\n- {question_2}\n\nPlease reply at your convenience. Your ticket will remain open.\n\nBest regards,\n{agent_name}' },
      { title: 'Pending Third Party', body: 'Hi {customer_name},\n\nWe are waiting for a response from {third_party} regarding your issue. We have followed up on our end and will update you as soon as we hear back.\n\nEstimated wait time: {timeline}.\n\nThank you,\n{agent_name}' },
    ],
  },
  {
    name: 'Resolution',
    templates: [
      { title: 'Issue Resolved', body: 'Hi {customer_name},\n\nGreat news — your ticket #{ticket_id} has been resolved. Here is what we did:\n\n{resolution_summary}\n\nPlease let us know if everything is working as expected. If you face any issues, simply reply to this message.\n\nThank you for your patience,\n{agent_name}' },
      { title: 'Refund Processed', body: 'Hi {customer_name},\n\nWe have processed a refund of {amount} for your order #{order_id}. It should reflect in your account within {days} business days.\n\nIf you do not see the refund after {days} days, please let us know.\n\nBest regards,\n{agent_name}' },
    ],
  },
  {
    name: 'Follow-up',
    templates: [
      { title: 'Satisfaction Check', body: 'Hi {customer_name},\n\nJust checking in — is everything working well after we resolved your ticket #{ticket_id}?\n\nIf you need any further help, we are here.\n\nBest,\n{agent_name}' },
      { title: 'Closing Inactive Ticket', body: 'Hi {customer_name},\n\nWe have not heard back on ticket #{ticket_id} for {days} days, so we are closing it for now.\n\nIf you still need help, just reply to this message and we will reopen it immediately.\n\nBest regards,\n{agent_name}' },
    ],
  },
  {
    name: 'Apology',
    templates: [
      { title: 'Service Disruption', body: 'Hi {customer_name},\n\nWe sincerely apologize for the service disruption you experienced. We understand how important uninterrupted service is to your business.\n\nHere is what happened: {incident_summary}\n\nWhat we are doing to prevent this: {prevention_steps}\n\nThank you for your understanding,\n{agent_name}' },
      { title: 'Delayed Response', body: 'Hi {customer_name},\n\nI apologize for the delayed response on your ticket #{ticket_id}. This fell below our usual response standards and I take full responsibility.\n\nI have reviewed your issue and {next_steps}.\n\nThank you for your patience,\n{agent_name}' },
    ],
  },
];

export function CannedResponses() {
  const [selectedCat, setSelectedCat] = useState(CATEGORIES[0].name);
  const [customTemplates, setCustomTemplates] = useState<Array<{ title: string; body: string }>>([]);
  const [editTitle, setEditTitle] = useState('');
  const [editBody, setEditBody] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const cat = CATEGORIES.find((c) => c.name === selectedCat);
  const allTemplates = [...(cat?.templates || []), ...(selectedCat === 'Custom' ? customTemplates : [])];

  const copy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  const addCustom = () => {
    if (!editTitle.trim() || !editBody.trim()) return;
    setCustomTemplates([...customTemplates, { title: editTitle, body: editBody }]);
    setEditTitle('');
    setEditBody('');
    setShowAdd(false);
    setSelectedCat('Custom');
  };

  const cats = [...CATEGORIES.map((c) => c.name), ...(customTemplates.length > 0 ? ['Custom'] : [])];

  return (
    <div>
      <h1 className="text-3xl font-bold text-[var(--da-text)] mb-2" style={{ fontFamily: 'var(--da-font-display)' }}>
        Canned Response Templates
      </h1>
      <p className="text-[var(--da-text-secondary)] mb-8">
        Ready-to-use response templates for support teams. Click to copy, customize the placeholders, and send.
      </p>

      <div className="flex gap-2 flex-wrap mb-6">
        {cats.map((name) => (
          <button
            key={name}
            onClick={() => setSelectedCat(name)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              selectedCat === name
                ? 'bg-[var(--da-gold)] text-[var(--da-bg)]'
                : 'bg-[var(--da-surface)] text-[var(--da-text-secondary)] border border-[var(--da-border)] hover:border-[var(--da-gold)]'
            }`}
          >
            {name}
          </button>
        ))}
      </div>

      <div className="space-y-4">
        {(selectedCat === 'Custom' ? customTemplates : cat?.templates || []).map((t, i) => (
          <div key={`${selectedCat}-${i}`} className="p-5 rounded-xl border border-[var(--da-border)] bg-[var(--da-surface)]">
            <div className="flex justify-between items-center mb-3">
              <h3 className="font-semibold text-[var(--da-text)]">{t.title}</h3>
              <button
                onClick={() => copy(t.body, `${selectedCat}-${i}`)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--da-gold)] text-[var(--da-bg)] hover:opacity-90 transition-opacity"
              >
                {copied === `${selectedCat}-${i}` ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <pre className="whitespace-pre-wrap text-sm text-[var(--da-text-secondary)] leading-relaxed font-sans">{t.body}</pre>
          </div>
        ))}
      </div>

      <div className="mt-8">
        {!showAdd ? (
          <button onClick={() => setShowAdd(true)} className="px-4 py-2 rounded-lg text-sm font-medium bg-[var(--da-surface)] text-[var(--da-gold)] border border-[var(--da-gold)] hover:bg-[var(--da-gold)] hover:text-[var(--da-bg)] transition-colors">
            + Add Custom Template
          </button>
        ) : (
          <div className="p-5 rounded-xl border border-[var(--da-gold)] bg-[var(--da-surface)]">
            <input
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              placeholder="Template title"
              className="w-full px-3 py-2 rounded-md text-sm mb-3"
            />
            <textarea
              value={editBody}
              onChange={(e) => setEditBody(e.target.value)}
              placeholder="Template body — use {placeholders} for dynamic values"
              rows={6}
              className="w-full px-3 py-2 rounded-md text-sm mb-3 resize-y"
            />
            <div className="flex gap-2">
              <button onClick={addCustom} className="px-4 py-2 rounded-lg text-sm font-medium bg-[var(--da-gold)] text-[var(--da-bg)]">Save</button>
              <button onClick={() => setShowAdd(false)} className="px-4 py-2 rounded-lg text-sm font-medium text-[var(--da-text-secondary)]">Cancel</button>
            </div>
          </div>
        )}
      </div>

      <div className="mt-10">
        <ShareButtons title="Canned Response Templates" url="https://desk.doaide.com/tools/canned-responses" />
      </div>
    </div>
  );
}
