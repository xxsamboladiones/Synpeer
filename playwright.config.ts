import { defineConfig, devices } from '@playwright/test';

const appUrl = 'http://127.0.0.1:8091';
const signalingUrl = 'ws://127.0.0.1:8797';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: {
    timeout: 20_000,
  },
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: appUrl,
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'npx expo start --web --port 8091',
      url: appUrl,
      reuseExistingServer: true,
      timeout: 120_000,
      env: {
        EXPO_PUBLIC_SYNPEER_SIGNALING_URL: signalingUrl,
      },
    },
    {
      command: 'node scripts/signaling-server.js',
      url: 'http://127.0.0.1:8797/health',
      reuseExistingServer: true,
      timeout: 30_000,
      env: {
        SYNPEER_SIGNALING_HOST: '127.0.0.1',
        SYNPEER_SIGNALING_PORT: '8797',
      },
    },
  ],
});
