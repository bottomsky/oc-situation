import { describe, expect, it } from 'vitest';
import { demoWorker, demoWorkers } from './demo-workers';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

function checkMetricsBindings(ports: number[]) {
  const moduleUrl = new URL('../packages/infrastructure/metrics.ts', import.meta.url).href;
  const script = `
    import { createServer } from 'node:net';
    const { startWorkerMetrics } = await import(${JSON.stringify(moduleUrl)});
    const ports = ${JSON.stringify(ports)};
    const allocated = new Map();
    const holders = [];
    for (const port of new Set(ports)) {
      const server = createServer();
      await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
      allocated.set(port,server.address().port);
      holders.push(server);
    }
    await Promise.all(holders.map(server=>new Promise(resolve=>server.close(resolve))));
    const metrics=ports.map((port,index)=>startWorkerMetrics({},'controlled-'+index,allocated.get(port)));
    const responses=await Promise.all(ports.map(port=>fetch('http://127.0.0.1:'+allocated.get(port)+'/metrics')));
    if(responses.some(response=>response.status!==200))throw new Error('Metrics endpoint unavailable');
    await Promise.all(metrics.map(worker=>worker.close()));
  `;
  return new Promise<{ code: number | null; stderr: string }>((resolveRun, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', script],
      {
        cwd: resolve(import.meta.dirname, '..'),
        env: { ...process.env, METRICS_HOST: '127.0.0.1' },
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Controlled metrics startup timed out'));
    }, 8000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      resolveRun({ code, stderr });
    });
  });
}

describe('local demo worker orchestration', () => {
  it('assigns separate metrics listeners to agent and both topic workers', () => {
    const roles = Object.keys(demoWorkers) as (keyof typeof demoWorkers)[];
    const ports = roles.map((role) => demoWorker(role).metricsPort);
    expect(new Set(ports).size).toBe(roles.length);
    expect(demoWorker('agent').metricsPort).toBe(13110);
    expect(demoWorker('topicLowSpeed').metricsPort).toBe(13109);
    expect(demoWorker('topicPortRestriction').metricsPort).toBe(13108);
    expect(demoWorker('writerPostgres').env.WRITER_TARGET).toBe('postgres');
    expect(demoWorker('writerClickhouse').env.WRITER_TARGET).toBe('clickhouse');
  });
  it('preserves inherited application configuration while overriding metrics ports per role', () => {
    const inherited = {
      AGENT_ENABLED: 'true',
      INTERNAL_METRICS_PORT: '13109',
      METRICS_PORT: '13109',
    };
    for (const role of Object.keys(demoWorkers) as (keyof typeof demoWorkers)[]) {
      const worker = demoWorker(role, inherited);
      expect(worker.env[worker.metricsVariable]).toBe(String(worker.metricsPort));
      expect(worker.env.AGENT_ENABLED).toBe('true');
    }
  });
  it('reproduces the previous shared-listener failure and starts distinct mapped metrics endpoints', async () => {
    const legacy = await checkMetricsBindings([13109, 13109]);
    expect(legacy.code).not.toBe(0);
    expect(legacy.stderr).toContain('EADDRINUSE');
    const fixed = await checkMetricsBindings([
      demoWorker('agent').metricsPort,
      demoWorker('topicLowSpeed').metricsPort,
    ]);
    expect(fixed).toEqual({ code: 0, stderr: '' });
  });
});
