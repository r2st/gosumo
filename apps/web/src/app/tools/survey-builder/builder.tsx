'use client';

import { useState } from 'react';
import { ShareButtons } from '@/components/share-buttons';

interface Question {
  text: string;
  enabled: boolean;
}

const SURVEY_TYPES: Record<string, { label: string; scale: string; questions: string[] }> = {
  'post-ticket': {
    label: 'Post-Ticket Survey',
    scale: '1–5 (Very Unsatisfied → Very Satisfied)',
    questions: [
      'How satisfied are you with the resolution of your issue?',
      'How would you rate the response time?',
      'Was the support agent knowledgeable and helpful?',
      'How easy was it to reach our support team?',
      'Would you contact us again for future issues?',
    ],
  },
  periodic: {
    label: 'Periodic Satisfaction Survey',
    scale: '1–5 (Strongly Disagree → Strongly Agree)',
    questions: [
      'Overall, I am satisfied with the product/service.',
      'The product/service meets my expectations.',
      'I would recommend this product/service to others.',
      'Customer support is responsive and helpful.',
      'The product/service offers good value for money.',
      'I plan to continue using this product/service.',
    ],
  },
  nps: {
    label: 'Net Promoter Score (NPS)',
    scale: '0–10 (Not at all likely → Extremely likely)',
    questions: [
      'How likely are you to recommend us to a friend or colleague?',
      'What is the primary reason for your score?',
      'What could we do to improve your experience?',
    ],
  },
  feedback: {
    label: 'Product Feedback Survey',
    scale: '1–5 (Poor → Excellent)',
    questions: [
      'How would you rate the overall quality of the product?',
      'How intuitive is the user interface?',
      'How well does the product meet your needs?',
      'How would you rate the performance and reliability?',
      'What features would you like to see added?',
      'What is the one thing you would change about the product?',
    ],
  },
};

export function SurveyBuilder() {
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [copied, setCopied] = useState(false);

  const selectType = (type: string) => {
    setSelectedType(type);
    setQuestions(SURVEY_TYPES[type].questions.map((q) => ({ text: q, enabled: true })));
  };

  const toggleQuestion = (idx: number) => {
    setQuestions((prev) => prev.map((q, i) => (i === idx ? { ...q, enabled: !q.enabled } : q)));
  };

  const updateQuestion = (idx: number, text: string) => {
    setQuestions((prev) => prev.map((q, i) => (i === idx ? { ...q, text } : q)));
  };

  const survey = selectedType ? SURVEY_TYPES[selectedType] : null;
  const enabledQuestions = questions.filter((q) => q.enabled);

  const surveyText = survey
    ? `${survey.label}\nRating Scale: ${survey.scale}\n\n${enabledQuestions.map((q, i) => `${i + 1}. ${q.text}`).join('\n')}\n\n---\nBuilt with DoAide Desk — https://desk.doaide.com/tools/survey-builder`
    : '';

  const copySurvey = async () => {
    try {
      await navigator.clipboard.writeText(surveyText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard unavailable */ }
  };

  return (
    <div>
      <h1 className="text-3xl font-bold text-[var(--doaide-text)] mb-2" style={{ fontFamily: 'var(--doaide-font-display)' }}>
        Customer Satisfaction Survey Builder
      </h1>
      <p className="text-[var(--doaide-text-secondary)] mb-8">
        Choose a survey type, customize questions, and copy a ready-to-use survey — no sign-up required.
      </p>

      <div className="space-y-6">
        <div className="p-6 rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)]">
          <h2 className="text-sm font-medium text-[var(--doaide-text-secondary)] mb-4">Survey Type</h2>
          <div className="grid grid-cols-2 gap-3">
            {Object.entries(SURVEY_TYPES).map(([key, val]) => (
              <button
                key={key}
                onClick={() => selectType(key)}
                className={`p-3 rounded-lg border text-sm font-medium transition-all text-left ${
                  selectedType === key
                    ? 'border-[var(--doaide-gold)] bg-[var(--doaide-gold)]/10 text-[var(--doaide-gold)]'
                    : 'border-[var(--doaide-border)] text-[var(--doaide-text)] hover:border-[var(--doaide-gold)]'
                }`}
              >
                {val.label}
              </button>
            ))}
          </div>
        </div>

        {survey && (
          <>
            <div className="p-6 rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)]">
              <div className="flex items-center justify-between mb-1">
                <h2 className="text-sm font-medium text-[var(--doaide-text-secondary)]">Questions</h2>
                <span className="text-xs text-[var(--doaide-text-muted)]">Scale: {survey.scale}</span>
              </div>
              <p className="text-xs text-[var(--doaide-text-muted)] mb-4">Toggle questions on/off and edit text as needed.</p>
              <div className="space-y-3">
                {questions.map((q, i) => (
                  <div key={i} className="flex items-start gap-3">
                    <button
                      onClick={() => toggleQuestion(i)}
                      className={`mt-1 w-5 h-5 rounded border flex-shrink-0 flex items-center justify-center text-xs transition-colors ${
                        q.enabled
                          ? 'bg-[var(--doaide-gold)] border-[var(--doaide-gold)] text-black'
                          : 'border-[var(--doaide-border)] text-transparent'
                      }`}
                    >
                      ✓
                    </button>
                    <input
                      type="text"
                      value={q.text}
                      onChange={(e) => updateQuestion(i, e.target.value)}
                      className={`flex-1 px-3 py-2 rounded-md text-sm ${q.enabled ? 'text-[var(--doaide-text)]' : 'text-[var(--doaide-text-muted)] line-through'}`}
                    />
                  </div>
                ))}
              </div>
            </div>

            <div className="p-6 rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)]">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-medium text-[var(--doaide-text-secondary)]">Survey Preview ({enabledQuestions.length} questions)</h2>
                <button
                  onClick={copySurvey}
                  className="px-4 py-1.5 rounded-lg bg-[var(--doaide-gold)] text-black text-sm font-medium hover:opacity-90 transition-opacity"
                >
                  {copied ? 'Copied!' : 'Copy Survey'}
                </button>
              </div>
              <pre className="text-sm text-[var(--doaide-text)] whitespace-pre-wrap font-mono bg-[var(--doaide-bg)] p-4 rounded-lg overflow-x-auto">
                {surveyText}
              </pre>
            </div>

            <ShareButtons url="https://desk.doaide.com/tools/survey-builder" title="Survey Builder — Free tool by DoAide Desk" />

            <div className="p-6 rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)] text-center">
              <p className="text-sm text-[var(--doaide-text-secondary)] mb-3">Want to send surveys automatically after each ticket?</p>
              <a href="/register" className="inline-block px-6 py-2.5 rounded-lg bg-[var(--doaide-gold)] text-black font-medium text-sm hover:opacity-90 transition-opacity">Sign up free</a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
