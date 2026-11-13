import { defineConfig } from 'vitest/config';

// The tests drive the built bundle (`bun run build`) with Miniflare from Node, as Console's agent tests do:
// @cloudflare/vitest-pool-workers can't load the OpenCode SDK through its module runner.
export default defineConfig({ test: { include: ['test/**/*.test.ts'], testTimeout: 120_000, hookTimeout: 180_000, fileParallelism: false } });
