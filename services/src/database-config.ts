export function getDatabaseUrl(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.DATABASE_URL !== undefined) {
    try {
      const url = new URL(environment.DATABASE_URL);
      if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) throw new Error();
      return environment.DATABASE_URL;
    } catch {
      throw new Error('DATABASE_URL must be a PostgreSQL connection URL.');
    }
  }
  const password = environment.TERRA_POSTGRES_PASSWORD;
  if (!password) throw new Error('Set DATABASE_URL or TERRA_POSTGRES_PASSWORD before starting database commands.');
  return `postgresql://terra:${encodeURIComponent(password)}@127.0.0.1:55432/terra`;
}
