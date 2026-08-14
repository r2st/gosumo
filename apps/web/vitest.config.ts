import { defineConfig, configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
    // e2e/ holds Playwright specs. They import from @playwright/test, which
    // throws under vitest, so collecting them left `vitest run` permanently
    // red — seven failing files that no code change could ever fix, which
    // trains everyone to ignore the exit code. They run via `test:e2e`.
    exclude: [...configDefaults.exclude, 'e2e/**'],
    coverage: {
      // Without an explicit `include`, v8 only instruments files some test
      // happened to import. That reported 93.70% while ~80 source files had
      // no test at all — they were absent from the table rather than listed
      // at 0%, so the gap was invisible. Naming the sources makes an untested
      // file show up as a 0% row and drags the headline number down with it.
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/__tests__/**',
        'src/**/*.d.ts',
      ],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
