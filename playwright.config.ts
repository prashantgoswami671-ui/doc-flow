import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',

  // Phase 3.3 tests each rasterize real PDFs through PDF.js + canvas in a
  // real Chromium instance. Running several of these concurrently (the
  // previous fullyParallel:true / workers:undefined config) was starving
  // the machine of canvas/GPU/memory resources, producing
  // net::ERR_INSUFFICIENT_RESOURCES, page crashes, and worker exit code
  // 3221226505 (0xC0000409) with zero usable test results. Forcing a
  // single worker and disabling file-level parallelism makes tests run
  // one at a time, which is the fix for that class of failure — it does
  // not change what any test asserts.
  fullyParallel: false,
  workers: 1,

  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // --disable-dev-shm-usage avoids Chromium's default /dev/shm size
        // being too small for canvas-heavy rendering (a common cause of
        // ERR_INSUFFICIENT_RESOURCES / renderer crashes); harmless on
        // platforms where /dev/shm isn't the constraint.
        launchOptions: {
          args: ['--disable-dev-shm-usage'],
        },
      },
    },
  ],

  // Temporarily disable the old rasterizer.spec.ts tests — this file
  // targets a /test/rasterizer route that no longer exists in app/, so
  // it isn't part of the Phase 3.3 baseline (see PHASE_3_3 report).
  testIgnore: ['**/rasterizer.spec.ts'],

  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
