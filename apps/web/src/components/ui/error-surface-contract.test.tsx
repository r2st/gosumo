/**
 * Every error surface must render a *cause*, not just a shrug.
 *
 * `ErrorState` produces cause-specific, actionable copy — offline vs. expired
 * session vs. no permission vs. outage — but only when it is handed the thrown
 * value. Passed nothing, it falls back to one sentence ("Something went wrong")
 * for every failure, and it offers a Retry button on a 403 or 404 that cannot
 * possibly succeed. The reader is then told the same thing whether they need to
 * check their wifi, sign in again, or ask an admin for access.
 *
 * That was the state of 28 of the 53 call sites: every settings page, every
 * analytics section, the bookings calendar, the onboarding wizard. Each one had
 * the query's `error` in scope and simply did not pass it.
 *
 * The rule is structural because the failure is invisible in a component test:
 * a page rendered against a mocked failing query looks right either way — the
 * generic copy *is* copy — so only reading the call sites catches it. The check
 * is deliberately blunt (does an `<ErrorState …>` mention `error=`?) since the
 * only way to get it wrong is to leave the prop off entirely.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ErrorState } from './states';
import { ApiError } from '@/lib/api-client';

const SRC = join(process.cwd(), 'src');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
    } else if (/\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Every `<ErrorState …>` element in the app, with the file it sits in. */
function errorStateUsages(): Array<{ file: string; element: string }> {
  const usages: Array<{ file: string; element: string }> = [];

  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    // `ErrorState` is always self-closing, so the element ends at the first
    // `/>` — no nesting to balance.
    for (let at = text.indexOf('<ErrorState'); at !== -1; at = text.indexOf('<ErrorState', at + 1)) {
      const end = text.indexOf('/>', at);
      usages.push({
        file: file.slice(SRC.length + 1),
        element: text.slice(at, end === -1 ? at + 400 : end + 2),
      });
    }
  }

  return usages;
}

describe('error surfaces', () => {
  const USAGES = errorStateUsages();

  it('finds the call sites to check', () => {
    // A drop to zero means the scan silently stopped covering anything —
    // a rename of the component, or a move out of `src`.
    expect(USAGES.length).toBeGreaterThan(40);
  });

  it('every ErrorState is handed the thrown value', () => {
    const bare = USAGES.filter((u) => !/\berror=/.test(u.element)).map(
      (u) => `${u.file}: ${u.element.replace(/\s+/g, ' ').slice(0, 80)}`,
    );

    expect(bare).toEqual([]);
  });

  // ─────────────────────────────────────────────
  // What the reader actually gets for it
  // ─────────────────────────────────────────────

  describe('the copy the prop buys', () => {
    it.each([
      [401, 'session has expired'],
      [403, 'permission'],
      [404, 'couldn’t find this'],
      [0, 'internet connection'],
    ])('a %s reads as something the operator can act on', (status, phrase) => {
      render(<ErrorState error={new ApiError(status, 'ERR', 'Request failed')} />);

      expect(screen.getByText(new RegExp(phrase, 'i'))).toBeInTheDocument();
    });

    it('offers a retry only where retrying could work', () => {
      const { rerender } = render(
        <ErrorState error={new ApiError(503, 'SERVICE_UNAVAILABLE', 'Request failed')} onRetry={() => undefined} />,
      );
      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();

      // A 403 does not become a 200 because the reader clicked again.
      rerender(<ErrorState error={new ApiError(403, 'FORBIDDEN', 'Forbidden')} onRetry={() => undefined} />);
      expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
    });

    it('falls back to the caller message when the error says nothing usable', () => {
      render(<ErrorState error={new ApiError(500, 'INTERNAL_ERROR', 'Internal Server Error')} message="Could not load leads." />);

      // A framework default is not an explanation; the authored fallback is.
      expect(screen.queryByText('Internal Server Error')).not.toBeInTheDocument();
    });
  });
});
