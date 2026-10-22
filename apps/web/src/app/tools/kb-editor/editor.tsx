'use client';

import { useState } from 'react';
import { ShareButtons } from '@/components/share-buttons';

interface Article {
  id: number;
  title: string;
  category: string;
  body: string;
  updatedAt: string;
}

const SAMPLE_ARTICLES: Article[] = [
  {
    id: 1, title: 'Getting Started with Your Account', category: 'Onboarding',
    body: '## Welcome!\n\nThank you for signing up. Here is how to get started:\n\n1. **Verify your email** — check your inbox for the confirmation link.\n2. **Complete your profile** — add your name and photo.\n3. **Explore the dashboard** — familiarize yourself with the main features.\n\n### Need help?\n\nContact support at any time using the chat widget in the bottom-right corner.',
    updatedAt: '2026-10-20',
  },
  {
    id: 2, title: 'How to Reset Your Password', category: 'Account',
    body: '## Password Reset\n\n1. Go to the **Login** page.\n2. Click **Forgot Password**.\n3. Enter your email and click **Send Reset Link**.\n4. Check your inbox and click the reset link.\n5. Enter your new password (minimum 8 characters).\n\n> If you do not receive the email within 5 minutes, check your spam folder.',
    updatedAt: '2026-10-18',
  },
];

let nextId = 10;

export function KBEditor() {
  const [articles, setArticles] = useState<Article[]>(SAMPLE_ARTICLES);
  const [editing, setEditing] = useState<Article | null>(null);
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState('All');

  const categories = ['All', ...Array.from(new Set(articles.map((a) => a.category)))];

  const filtered = articles.filter((a) => {
    const matchCat = catFilter === 'All' || a.category === catFilter;
    const matchSearch = !search || a.title.toLowerCase().includes(search.toLowerCase()) || a.body.toLowerCase().includes(search.toLowerCase());
    return matchCat && matchSearch;
  });

  const startNew = () => {
    setEditing({ id: nextId++, title: '', category: '', body: '', updatedAt: new Date().toISOString().slice(0, 10) });
  };

  const save = () => {
    if (!editing || !editing.title.trim()) return;
    const updated = { ...editing, updatedAt: new Date().toISOString().slice(0, 10) };
    const idx = articles.findIndex((a) => a.id === updated.id);
    if (idx >= 0) {
      const copy = [...articles];
      copy[idx] = updated;
      setArticles(copy);
    } else {
      setArticles([...articles, updated]);
    }
    setEditing(null);
  };

  const remove = (id: number) => {
    setArticles(articles.filter((a) => a.id !== id));
    if (editing?.id === id) setEditing(null);
  };

  const exportMd = (a: Article) => {
    const content = `# ${a.title}\n\nCategory: ${a.category}\nLast updated: ${a.updatedAt}\n\n${a.body}`;
    const blob = new Blob([content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${a.title.toLowerCase().replace(/\s+/g, '-')}.md`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const renderMd = (text: string) => {
    return text
      .replace(/^### (.+)$/gm, '<h3 class="text-base font-semibold mt-4 mb-1">$1</h3>')
      .replace(/^## (.+)$/gm, '<h2 class="text-lg font-bold mt-4 mb-2">$1</h2>')
      .replace(/^> (.+)$/gm, '<blockquote class="border-l-2 border-[var(--da-gold)] pl-3 text-sm italic text-[var(--da-text-muted)]">$1</blockquote>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/^\d+\. (.+)$/gm, '<li class="ml-4 list-decimal text-sm">$1</li>')
      .replace(/\n/g, '<br/>');
  };

  return (
    <div>
      <h1 className="text-3xl font-bold text-[var(--da-text)] mb-2" style={{ fontFamily: 'var(--da-font-display)' }}>
        Knowledge Base Editor
      </h1>
      <p className="text-[var(--da-text-secondary)] mb-8">
        Create and manage knowledge base articles for your support team. Write in Markdown, organize by category, and export.
      </p>

      {editing ? (
        <div className="p-6 rounded-xl border border-[var(--da-gold)] bg-[var(--da-surface)]">
          <h2 className="text-sm font-medium text-[var(--da-text-secondary)] mb-4">{editing.id >= 10 ? 'New Article' : 'Edit Article'}</h2>
          <div className="grid gap-3 sm:grid-cols-2 mb-3">
            <input value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} placeholder="Article title"
              className="w-full px-3 py-2 rounded-md text-sm" />
            <input value={editing.category} onChange={(e) => setEditing({ ...editing, category: e.target.value })} placeholder="Category (e.g. Onboarding)"
              className="w-full px-3 py-2 rounded-md text-sm" />
          </div>
          <textarea value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })}
            placeholder="Write in Markdown..." rows={12} className="w-full px-3 py-2 rounded-md text-sm font-mono resize-y mb-3" />

          {editing.body && (
            <div className="p-4 rounded-lg border border-[var(--da-border)] bg-[var(--da-bg)] mb-3">
              <p className="text-xs text-[var(--da-text-muted)] mb-2">Preview</p>
              <div className="text-sm text-[var(--da-text)] leading-relaxed" dangerouslySetInnerHTML={{ __html: renderMd(editing.body) }} />
            </div>
          )}

          <div className="flex gap-2">
            <button onClick={save} className="px-4 py-2 rounded-lg text-sm font-medium bg-[var(--da-gold)] text-[var(--da-bg)]">Save</button>
            <button onClick={() => setEditing(null)} className="px-4 py-2 rounded-lg text-sm font-medium text-[var(--da-text-secondary)]">Cancel</button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex gap-3 flex-wrap mb-4">
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search articles..."
              className="flex-1 min-w-[200px] px-3 py-2 rounded-md text-sm" />
            <select value={catFilter} onChange={(e) => setCatFilter(e.target.value)} className="px-3 py-2 rounded-md text-sm">
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <button onClick={startNew}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-[var(--da-gold)] text-[var(--da-bg)]">
              + New Article
            </button>
          </div>

          {filtered.length === 0 ? (
            <p className="text-sm text-[var(--da-text-muted)] text-center py-8">No articles found.</p>
          ) : (
            <div className="space-y-3">
              {filtered.map((a) => (
                <div key={a.id} className="p-4 rounded-xl border border-[var(--da-border)] bg-[var(--da-surface)]">
                  <div className="flex justify-between items-start mb-2">
                    <div>
                      <h3 className="text-sm font-semibold text-[var(--da-text)]">{a.title}</h3>
                      <p className="text-xs text-[var(--da-text-muted)]">{a.category} · Updated {a.updatedAt}</p>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => setEditing({ ...a })} className="text-xs text-[var(--da-gold)] hover:underline">Edit</button>
                      <button onClick={() => exportMd(a)} className="text-xs text-[var(--da-text-secondary)] hover:underline">Export</button>
                      <button onClick={() => remove(a.id)} className="text-xs text-[var(--da-text-muted)] hover:text-[var(--da-error)]">Delete</button>
                    </div>
                  </div>
                  <div className="text-xs text-[var(--da-text-secondary)] leading-relaxed line-clamp-3"
                    dangerouslySetInnerHTML={{ __html: renderMd(a.body) }} />
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <div className="mt-10">
        <ShareButtons title="Knowledge Base Editor" url="https://desk.doaide.com/tools/kb-editor" />
      </div>
    </div>
  );
}
