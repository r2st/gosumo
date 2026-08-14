/**
 * `.env.example` completeness contract.
 *
 * The deployment checklist is "copy .env.example and fill it in". Anything the
 * API reads but that file never mentions is therefore invisible to the person
 * deploying — and the failure is quiet, because almost every setting here has a
 * fallback. An unset provider credential degrades to simulation mode; an unset
 * CHANNEL_ENCRYPTION_KEY falls back to a constant in this repository. Nothing
 * crashes. The deployment just isn't what the operator thinks it is.
 *
 * So this asserts the file documents every variable the process actually reads,
 * from both sources: the `app.config` factory and the handful of direct
 * `process.env` reads that bypass it. Commented-out entries count as documented
 * — an optional setting is meant to be shown and left off.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const ENV_EXAMPLE = readFileSync(join(__dirname, '../../.env.example'), 'utf8');
const APP_CONFIG_SOURCE = readFileSync(join(__dirname, 'app.config.ts'), 'utf8');

/**
 * Files that read `process.env` directly rather than through ConfigService.
 * These are the easiest to miss, because they never appear in app.config.
 */
const DIRECT_ENV_READERS = [
  '../common/utils/encryption.util.ts',
  '../main.ts',
] as const;

/** Every `process.env['X']` / `process.env.X` name in a source file. */
function envNamesIn(source: string): string[] {
  const bracket = [...source.matchAll(/process\.env\['([A-Z][A-Z_0-9]*)'\]/g)];
  const dotted = [...source.matchAll(/process\.env\.([A-Z][A-Z_0-9]*)/g)];
  return [...new Set([...bracket, ...dotted].map((m) => m[1]!))];
}

/** Names assigned in .env.example, including commented-out ones. */
const DOCUMENTED = new Set(
  [...ENV_EXAMPLE.matchAll(/^#?\s*([A-Z][A-Z_0-9]*)=/gm)].map((m) => m[1]!),
);

const CONFIG_KEYS = envNamesIn(APP_CONFIG_SOURCE);

const DIRECT_KEYS = [
  ...new Set(
    DIRECT_ENV_READERS.flatMap((rel) =>
      envNamesIn(readFileSync(join(__dirname, rel), 'utf8')),
    ),
  ),
];

describe('.env.example contract', () => {
  it('reads a non-trivial number of settings from app.config', () => {
    // Guards the regexes above: if they silently stopped matching, every
    // per-key assertion below would vacuously pass.
    expect(CONFIG_KEYS.length).toBeGreaterThan(30);
  });

  describe('app.config settings', () => {
    it.each(CONFIG_KEYS)('documents %s', (name) => {
      expect(DOCUMENTED.has(name)).toBe(true);
    });
  });

  describe('settings read directly from process.env', () => {
    it('finds the direct readers it expects', () => {
      expect(DIRECT_KEYS).toContain('CHANNEL_ENCRYPTION_KEY');
    });

    it.each(DIRECT_KEYS)('documents %s', (name) => {
      expect(DOCUMENTED.has(name)).toBe(true);
    });
  });

  describe('secrets with a silent fallback carry a warning', () => {
    it('says what CHANNEL_ENCRYPTION_KEY falls back to when unset', () => {
      // The fallback chain ends at a string committed to this repo, so an
      // operator who skips this line gets credentials that are encoded, not
      // encrypted. The file has to say so.
      const section = /CHANNEL_ENCRYPTION_KEY[\s\S]{0,80}=/.exec(ENV_EXAMPLE);
      expect(section).not.toBeNull();
      const preamble = ENV_EXAMPLE.slice(
        Math.max(0, ENV_EXAMPLE.indexOf('CHANNEL_ENCRYPTION_KEY=') - 600),
        ENV_EXAMPLE.indexOf('CHANNEL_ENCRYPTION_KEY='),
      );
      expect(preamble).toMatch(/JWT_SECRET/);
      expect(preamble).toMatch(/committed|repository|no encryption/i);
    });

    it('warns that ENABLE_SWAGGER exposes every route in production', () => {
      expect(ENV_EXAMPLE).toMatch(/ENABLE_SWAGGER/);
      expect(ENV_EXAMPLE).toMatch(/publishes every\s*#?\s*route/);
    });
  });
});
