/** Bound only the agent's PostgreSQL connections; retain every existing URL option. */
export function agentDatabaseUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  const existing = url.searchParams.getAll('options').filter(Boolean).join(' ');
  url.searchParams.set(
    'options',
    [existing, '-c statement_timeout=60000', '-c lock_timeout=5000'].filter(Boolean).join(' '),
  );
  return url.toString();
}
