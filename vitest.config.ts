import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@engramweave/contracts': fileURLToPath(new URL('./packages/contracts/src/index.ts', import.meta.url)) } },
  test: {
    include: ['tests/**/*.test.ts'],
    // Real NTFS, PowerShell attribute checks and Core restarts need bounded I/O budgets.
    testTimeout: 60_000,
    hookTimeout: 30_000,
    maxWorkers: 4,
  },
});
