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
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
