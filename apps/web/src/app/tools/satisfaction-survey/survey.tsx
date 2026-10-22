'use client';

import { useState } from 'react';
import { ShareButtons } from '@/components/share-buttons';

interface Question {
  id: number;
  text: string;
  type: 'rating' | 'nps' | 'text' | 'choice';
  options?: string[];
}

const DEFAULT_QUESTIONS: Question[] = [
  { id: 1, text: 'How satisfied are you with the support you received?', type: 'rating' },
  { id: 2, text: 'How likely are you to recommend our support to a colleague?', type: 'nps' },
  { id: 3, text: 'Was your issue resolved?', type: 'choice', options: ['Yes, completely', 'Partially', 'No'] },
  { id: 4, text: 'How would you rate our response time?', type: 'rating' },
  { id: 5, text: 'Any additional feedback or suggestions?', type: 'text' },
];

let qid = 100;

export function SatisfactionSurvey() {
  const [questions, setQuestions] = useState<Question[]>(DEFAULT_QUESTIONS);
  const [preview, setPreview] = useState(false);
  const [answers, setAnswers] = useState<Record<number, string | number>>({});
  const [addType, setAddType] = useState<Question['type']>('rating');
  const [addText, setAddText] = useState('');
  const [addOptions, setAddOptions] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const addQuestion = () => {
    if (!addText.trim()) return;
    const q: Question = { id: qid++, text: addText, type: addType };
    if (addType === 'choice') q.options = addOptions.split(',').map((o) => o.trim()).filter(Boolean);
    setQuestions([...questions, q]);
    setAddText('');
    setAddOptions('');
  };

  const removeQuestion = (id: number) => setQuestions(questions.filter((q) => q.id !== id));

  const handleSubmit = () => setSubmitted(true);

  const exportJson = () => {
    const data = JSON.stringify({ questions, answers }, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'csat-survey-template.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const npsScore = () => {
    const npsQ = questions.find((q) => q.type === 'nps');
    if (!npsQ || typeof answers[npsQ.id] !== 'number') return null;
    const v = answers[npsQ.id] as number;
    if (v >= 9) return { label: 'Promoter', color: 'var(--da-success)' };
    if (v >= 7) return { label: 'Passive', color: 'var(--da-gold)' };
    return { label: 'Detractor', color: 'var(--da-error)' };
  };

  return (
    <div>
      <h1 className="text-3xl font-bold text-[var(--da-text)] mb-2" style={{ fontFamily: 'var(--da-font-display)' }}>
        Customer Satisfaction Survey Builder
      </h1>
      <p className="text-[var(--da-text-secondary)] mb-8">
        Create CSAT and NPS surveys for your support team. Preview, customize questions, and export the template.
      </p>

      <div className="flex gap-3 mb-6">
        <button onClick={() => { setPreview(false); setSubmitted(false); }}
          className={`px-4 py-2 rounded-lg text-sm font-medium ${!preview ? 'bg-[var(--da-gold)] text-[var(--da-bg)]' : 'bg-[var(--da-surface)] text-[var(--da-text-secondary)] border border-[var(--da-border)]'}`}>
          Edit
        </button>
        <button onClick={() => { setPreview(true); setSubmitted(false); setAnswers({}); }}
          className={`px-4 py-2 rounded-lg text-sm font-medium ${preview ? 'bg-[var(--da-gold)] text-[var(--da-bg)]' : 'bg-[var(--da-surface)] text-[var(--da-text-secondary)] border border-[var(--da-border)]'}`}>
          Preview
        </button>
        <button onClick={exportJson}
          className="px-4 py-2 rounded-lg text-sm font-medium bg-[var(--da-surface)] text-[var(--da-text-secondary)] border border-[var(--da-border)] hover:border-[var(--da-gold)]">
          Export JSON
        </button>
      </div>

      {!preview ? (
        <>
          <div className="space-y-3 mb-6">
            {questions.map((q, i) => (
              <div key={q.id} className="flex items-center gap-3 p-3 rounded-lg border border-[var(--da-border)] bg-[var(--da-surface)]">
                <span className="text-xs font-bold text-[var(--da-text-muted)] w-6">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-[var(--da-text)]">{q.text}</p>
                  <p className="text-xs text-[var(--da-text-muted)]">Type: {q.type}{q.options ? ` — ${q.options.join(', ')}` : ''}</p>
                </div>
                <button onClick={() => removeQuestion(q.id)} className="text-xs text-[var(--da-text-muted)] hover:text-[var(--da-error)]">×</button>
              </div>
            ))}
          </div>

          <div className="p-5 rounded-xl border border-[var(--da-border)] bg-[var(--da-surface)]">
            <h2 className="text-sm font-medium text-[var(--da-text-secondary)] mb-3">Add Question</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <input value={addText} onChange={(e) => setAddText(e.target.value)} placeholder="Question text"
                  className="w-full px-3 py-2 rounded-md text-sm" />
              </div>
              <div>
                <select value={addType} onChange={(e) => setAddType(e.target.value as Question['type'])} className="w-full px-3 py-2 rounded-md text-sm">
                  <option value="rating">Rating (1-5 stars)</option>
                  <option value="nps">NPS (0-10)</option>
                  <option value="choice">Multiple Choice</option>
                  <option value="text">Free Text</option>
                </select>
              </div>
              {addType === 'choice' && (
                <div>
                  <input value={addOptions} onChange={(e) => setAddOptions(e.target.value)} placeholder="Options (comma separated)"
                    className="w-full px-3 py-2 rounded-md text-sm" />
                </div>
              )}
            </div>
            <button onClick={addQuestion} className="mt-3 px-4 py-2 rounded-lg text-sm font-medium bg-[var(--da-gold)] text-[var(--da-bg)]">
              Add Question
            </button>
          </div>
        </>
      ) : submitted ? (
        <div className="p-8 rounded-xl border border-[var(--da-border)] bg-[var(--da-surface)] text-center">
          <p className="text-2xl mb-2">Thank you!</p>
          <p className="text-sm text-[var(--da-text-secondary)] mb-4">Your feedback has been recorded.</p>
          {npsScore() && (
            <span className="text-xs font-bold px-3 py-1 rounded-full" style={{ color: npsScore()!.color, backgroundColor: `${npsScore()!.color}22` }}>
              NPS: {npsScore()!.label} ({answers[questions.find((q) => q.type === 'nps')!.id]}/10)
            </span>
          )}
        </div>
      ) : (
        <div className="p-6 rounded-xl border border-[var(--da-border)] bg-[var(--da-surface)]">
          <h2 className="text-lg font-semibold text-[var(--da-text)] mb-6">Customer Satisfaction Survey</h2>
          <div className="space-y-6">
            {questions.map((q) => (
              <div key={q.id}>
                <p className="text-sm font-medium text-[var(--da-text)] mb-2">{q.text}</p>
                {q.type === 'rating' && (
                  <div className="flex gap-2">
                    {[1, 2, 3, 4, 5].map((v) => (
                      <button key={v} onClick={() => setAnswers({ ...answers, [q.id]: v })}
                        className={`w-10 h-10 rounded-lg text-sm font-bold ${answers[q.id] === v ? 'bg-[var(--da-gold)] text-[var(--da-bg)]' : 'bg-[var(--da-bg)] text-[var(--da-text-secondary)] border border-[var(--da-border)]'}`}>
                        {v}
                      </button>
                    ))}
                  </div>
                )}
                {q.type === 'nps' && (
                  <div className="flex gap-1 flex-wrap">
                    {Array.from({ length: 11 }, (_, i) => i).map((v) => (
                      <button key={v} onClick={() => setAnswers({ ...answers, [q.id]: v })}
                        className={`w-9 h-9 rounded-lg text-xs font-bold ${answers[q.id] === v ? 'bg-[var(--da-gold)] text-[var(--da-bg)]' : 'bg-[var(--da-bg)] text-[var(--da-text-secondary)] border border-[var(--da-border)]'}`}>
                        {v}
                      </button>
                    ))}
                  </div>
                )}
                {q.type === 'choice' && q.options && (
                  <div className="flex gap-2 flex-wrap">
                    {q.options.map((opt) => (
                      <button key={opt} onClick={() => setAnswers({ ...answers, [q.id]: opt })}
                        className={`px-3 py-2 rounded-lg text-sm ${answers[q.id] === opt ? 'bg-[var(--da-gold)] text-[var(--da-bg)]' : 'bg-[var(--da-bg)] text-[var(--da-text-secondary)] border border-[var(--da-border)]'}`}>
                        {opt}
                      </button>
                    ))}
                  </div>
                )}
                {q.type === 'text' && (
                  <textarea value={(answers[q.id] as string) || ''} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
                    placeholder="Your feedback..." rows={3} className="w-full px-3 py-2 rounded-md text-sm resize-y" />
                )}
              </div>
            ))}
          </div>
          <button onClick={handleSubmit} className="mt-6 px-6 py-2.5 rounded-lg text-sm font-medium bg-[var(--da-gold)] text-[var(--da-bg)]">
            Submit Survey
          </button>
        </div>
      )}

      <div className="mt-10">
        <ShareButtons title="Customer Satisfaction Survey Builder" url="https://desk.doaide.com/tools/satisfaction-survey" />
      </div>
    </div>
  );
}
