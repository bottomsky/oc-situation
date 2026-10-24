const applicationEntries: Record<string, string> = {
  api: 'src/main.ts',
  collector: 'src/main.ts',
  crawler: 'src/main.ts',
  processor: 'main.ts',
  writer: 'main.ts',
  archiver: 'main.ts',
  intelligence: 'main.ts',
  topics: 'main.ts',
  agent: 'main.ts',
};
export function extraBuildEntries(name: string): { entry: string; output: string }[] {
  return name === 'topics'
    ? [{ entry: 'prediction-worker.ts', output: 'dist/prediction-worker.mjs' }]
    : [];
}
export function buildPlan(name: string) {
  if (applicationEntries[name])
    return { entry: applicationEntries[name], output: 'dist/main.mjs', migrations: true };
  if (['contracts', 'domain', 'source-adapters', 'infrastructure'].includes(name))
    return { entry: 'index.ts', output: 'dist/index.mjs', migrations: name === 'infrastructure' };
  throw new Error(`Unknown build workspace: ${name}`);
}
