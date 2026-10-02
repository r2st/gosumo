/**
 * Silent-catch contract — G003 observability ratchet.
 *
 * A `.catch(() => ...)` that neither logs nor re-throws is invisible in
 * production: the operation fails, nothing records why, and the operator
 * discovers it only when the downstream effect is noticed — hours or days
 * later, with no correlation id to start from.
 *
 * This test scans every non-test TypeScript file for `.catch(` patterns
 * whose handler body contains no logging and no re-throw. Legitimate
 * fire-and-forget silences are allow-listed below with a one-line reason.
 *
 * Adding a new allow-list entry requires explaining why the failure is
 * genuinely uninteresting — "best-effort cleanup" is fine, "I don't know
 * what to log" is not.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Relative path + reason this silence is acceptable. */
const ALLOWED_SILENCES: Record<string, string> = {
  // Aborting a ReadableStream reader during a download timeout — the read
  // is already dead, so the cancel failing changes nothing.
  'common/utils/media-download.util.ts:reader.cancel': 'cleanup of already-dead stream reader',
  // Best-effort DB update inside handleCalendarAuthFailure, which already
  // logs the auth failure at error level on the next line.
  'modules/booking/booking.service.ts:.catch(() => undefined)': 'best-effort inside an error handler that already logs',
};

function isAllowed(relativePath: string, snippet: string): boolean {
  for (const key of Object.keys(ALLOWED_SILENCES)) {
    const [fileSuffix, marker] = key.split(':');
    if (relativePath.endsWith(fileSuffix!) && (!marker || snippet.includes(marker))) {
      return true;
    }
  }
  return false;
}

/**
 * Matches `.catch(() => ...)` or `.catch((_) => ...)` or `.catch((_err) => ...)`
 * where the handler body does NOT contain a logging call.
 */
function findSilentInlineCatches(
  filePath: string,
  content: string,
): Array<{ line: number; text: string }> {
  const lines = content.split('\n');
  const results: Array<{ line: number; text: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Match .catch( with an arrow function
    if (!/\.catch\s*\(\s*\(?[^)]*\)?\s*=>/i.test(line)) continue;

    // Gather the full statement (may span a few lines)
    const contextLines = lines.slice(i, Math.min(lines.length, i + 8)).join('\n');

    // Check if the catch handler body contains logging or re-throw
    const hasLogging = /this\.logger\.|console\.|Logger\.|\.log\(|\.warn\(|\.error\(|\.debug\(/i.test(contextLines);
    const hasThrow = /\bthrow\b/.test(contextLines);

    if (!hasLogging && !hasThrow) {
      const relative = path.relative(
        path.join(__dirname, '..'),
        filePath,
      );
      if (!isAllowed(relative, line)) {
        results.push({ line: i + 1, text: line.trim() });
      }
    }
  }

  return results;
}

function walkTs(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      results.push(...walkTs(full));
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.spec.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      results.push(full);
    }
  }
  return results;
}

describe('silent-catch contract', () => {
  const srcRoot = path.resolve(__dirname, '..');
  const files = walkTs(srcRoot);

  it('no production .ts file should have a .catch(() => ...) without logging', () => {
    const violations: string[] = [];

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      const silent = findSilentInlineCatches(file, content);
      for (const s of silent) {
        const relative = path.relative(srcRoot, file);
        violations.push(`${relative}:${s.line}: ${s.text}`);
      }
    }

    expect(violations).toEqual([]);
  });
});
