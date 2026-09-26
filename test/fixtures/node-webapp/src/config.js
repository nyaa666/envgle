// Fixture source for envgle integration tests. Never executed.
// Three shapes of the same accessor: dot access, a ?? fallback and a
// destructuring bind. SEARCH_ENDPOINT and APP_ENV are read but never declared.
import 'dotenv/config';

const endpoint = process.env.SEARCH_ENDPOINT;
const region = process.env.APP_ENV ?? 'dev';
const { PORT } = process.env;
const analyticsKey = process.env.REACT_APP_ANALYTICS_KEY ?? 'off';
const logFormat = process.env.LOG_FORMAT ?? 'pretty';
// A hardcoded fallback credential in version control: secret-fallback-literal.
const githubToken = process.env.GITHUB_TOKEN ?? 'ghp_EXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLE1234';

export const config = {
  endpoint,
  region,
  port: PORT,
  analyticsKey,
  logFormat,
  githubToken,
};
