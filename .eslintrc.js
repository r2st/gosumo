module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'prettier',
  ],
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/explicit-function-return-type': 'warn',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    // `noUncheckedIndexedAccess` is on repo-wide (tsconfig.base.json), so every
    // `arr[i]` and every regex capture group is `T | undefined`. Requiring a
    // runtime guard for indices the surrounding code has already proven safe
    // adds noise without adding safety, so this is a warning rather than an
    // error. Assertions on genuinely nullable values (Map.get, Array.find,
    // Record lookups on open key types) are still bugs — fix those.
    '@typescript-eslint/no-non-null-assertion': 'warn',
  },
  overrides: [
    {
      // Test files legitimately reach into mock call arrays and fixtures whose
      // shape the test itself establishes.
      files: ['**/*.spec.ts', '**/test/**/*.ts'],
      rules: {
        '@typescript-eslint/no-non-null-assertion': 'off',
        '@typescript-eslint/explicit-function-return-type': 'off',
        // Contract specs walk the built module graph with dynamic require().
        '@typescript-eslint/no-require-imports': 'off',
      },
    },
  ],
  ignorePatterns: ['dist/', 'node_modules/', 'coverage/'],
};
