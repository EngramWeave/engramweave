import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@engramweave/contracts': fileURLToPath(new URL('./packages/contracts/src/index.ts', import.meta.url)) } },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 15_000 },
});
