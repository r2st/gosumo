import { test as base, expect } from '@playwright/test';

/**
 * Custom test fixture that uses stored authentication state.
 * Tests importing this `test` object will start already logged in.
 */
export const test = base.extend({});
export { expect };
