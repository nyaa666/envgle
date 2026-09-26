// Fixture source for envgle integration tests. Never executed.
// Every variable is read with an explicit fallback, so nothing in this file can
// make the process fail on a machine that has no .env at all.
export const config = {
  appName: process.env.APP_NAME ?? 'example-web',
  port: Number(process.env.PORT ?? 3000),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  backendUrl: process.env.BACKEND_URL ?? 'https://api.example.com',
  featureFlags: process.env.FEATURE_FLAGS ?? 'checkout,search',
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS ?? 5000),
};
