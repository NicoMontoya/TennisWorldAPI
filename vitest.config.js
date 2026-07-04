import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // predict/model.test.js uses node:test — run it with `node --test`,
        // not vitest (it has no vitest suite and fails collection here).
        include: ['src/**/*.test.js'],
        exclude: ['src/predict/**'],
        environment: 'node',
    },
});
