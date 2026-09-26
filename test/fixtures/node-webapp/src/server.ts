// Fixture source for envgle integration tests. Never executed.
// The same accessor with types the compiler checks, including one name that no
// env file declares (HOST).
interface ServerEnv {
  readonly host: string;
  readonly port: number;
  readonly baseUrl: string;
  readonly region: string;
}

const host: string = process.env.HOST ?? '127.0.0.1';
const port: number = Number(process.env.PORT ?? 3000);
const baseUrl: string = process.env.API_BASE_URL ?? 'http://localhost:3000';
const region: string = process.env.APP_ENV ?? 'dev';

export const serverEnv: ServerEnv = { host, port, baseUrl, region };
