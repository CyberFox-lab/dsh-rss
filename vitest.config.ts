import { defineConfig } from 'vitest/config'

export default defineConfig({
  ssr: { noExternal: ['@deepseek-ai/dsh-client-ui-primitives'] },
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    environment: 'node',
    testTimeout: 10_000,
  },
})
