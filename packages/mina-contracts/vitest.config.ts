import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * o1js's `@state` / `@method` decorators depend on `emitDecoratorMetadata`,
 * which esbuild (vitest's default transformer) does not implement. SWC does,
 * so the whole package is transformed with it instead.
 */
export default defineConfig({
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    pool: 'forks',
  },
});
