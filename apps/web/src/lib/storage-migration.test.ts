import { beforeEach, describe, expect, it, vi } from 'vitest';

const store: Record<string, string> = {};
const mockStorage = {
  getItem: (key: string) => (key in store ? store[key] : null),
  setItem: (key: string, val: string) => { store[key] = String(val); },
  removeItem: (key: string) => { delete store[key]; },
  clear: () => { for (const k of Object.keys(store)) delete store[k]; },
};
Object.defineProperty(globalThis, 'localStorage', { value: mockStorage, writable: true });

describe('token-store migration', () => {
  beforeEach(() => {
    mockStorage.clear();
    vi.resetModules();
  });

  it('migrates gosumo.refreshToken to desk.refreshToken', async () => {
    mockStorage.setItem('gosumo.refreshToken', 'old-refresh-jwt');
    await import('./token-store');
    expect(mockStorage.getItem('desk.refreshToken')).toBe('old-refresh-jwt');
    expect(mockStorage.getItem('gosumo.refreshToken')).toBeNull();
  });

  it('does not overwrite an existing desk.refreshToken', async () => {
    mockStorage.setItem('desk.refreshToken', 'already-migrated');
    mockStorage.setItem('gosumo.refreshToken', 'stale');
    await import('./token-store');
    expect(mockStorage.getItem('desk.refreshToken')).toBe('already-migrated');
  });
});

describe('theme-provider migration', () => {
  beforeEach(() => {
    mockStorage.clear();
    vi.resetModules();
  });

  it('migrates gosumo-theme to desk-theme', async () => {
    mockStorage.setItem('gosumo-theme', 'dark');
    await import('../providers/theme-provider');
    expect(mockStorage.getItem('desk-theme')).toBe('dark');
    expect(mockStorage.getItem('gosumo-theme')).toBeNull();
  });

  it('does not overwrite an existing desk-theme', async () => {
    mockStorage.setItem('desk-theme', 'light');
    mockStorage.setItem('gosumo-theme', 'dark');
    await import('../providers/theme-provider');
    expect(mockStorage.getItem('desk-theme')).toBe('light');
  });
});

describe('i18n migration', () => {
  beforeEach(() => {
    mockStorage.clear();
    vi.resetModules();
  });

  it('migrates gosumo-lang to desk-lang', async () => {
    mockStorage.setItem('gosumo-lang', 'hi');
    await import('./i18n');
    expect(mockStorage.getItem('desk-lang')).toBe('hi');
    expect(mockStorage.getItem('gosumo-lang')).toBeNull();
  });

  it('does not overwrite an existing desk-lang', async () => {
    mockStorage.setItem('desk-lang', 'en');
    mockStorage.setItem('gosumo-lang', 'hi');
    await import('./i18n');
    expect(mockStorage.getItem('desk-lang')).toBe('en');
  });
});
