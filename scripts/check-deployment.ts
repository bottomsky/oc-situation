import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse, parseAllDocuments } from 'yaml';

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
const list = (value: unknown): RecordValue[] => (Array.isArray(value) ? value.map(object) : []);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);
const at = (value: unknown, ...keys: string[]): unknown =>
  keys.reduce<unknown>((current, key) => object(current)[key], value);
const root = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const metrics: Record<string, number> = {
  api: 13100,
  processor: 13101,
  'postgres-writer': 13102,
  'clickhouse-writer': 13103,
  archiver: 13104,
  collector: 13105,
  crawler: 13106,
  intelligence: 13107,
  'topic-port-restriction': 13108,
  'topic-low-speed': 13109,
  agent: 13110,
};
export function documents(source: string): RecordValue[] {
  return parseAllDocuments(source, { merge: true })
    .map((document) => {
      if (document.errors.length)
        throw new Error(document.errors.map((error) => error.message).join('\n'));
      return object(document.toJS());
    })
    .filter((document) => Object.keys(document).length);
}

/** Checks resolved resources against synthetic Secret contracts, never cluster state. */
export function validateResources(resources: RecordValue[]): string[] {
  const errors: string[] = [];
  const check = (condition: unknown, message: string) => {
    if (!condition) errors.push(message);
  };
  const name = (resource: RecordValue) => String(at(resource, 'metadata', 'name'));
  const find = (kind: string, id: unknown) =>
    resources.find((resource) => resource.kind === kind && name(resource) === id);
  const workloads = resources.filter((resource) =>
    ['Deployment', 'StatefulSet', 'Job'].includes(String(resource.kind)),
  );
  const seen = new Set<string>();
  for (const resource of resources) {
    const key = `${String(resource.kind)}/${name(resource)}`;
    check(
      resource.apiVersion && resource.kind && name(resource) !== 'undefined',
      `Invalid resource ${key}`,
    );
    check(!seen.has(key), `Duplicate resource ${key}`);
    seen.add(key);
    if (resource.kind !== 'Namespace')
      check(at(resource, 'metadata', 'namespace') === 'ais-platform', `${key}: namespace required`);
    if (resource.kind === 'PersistentVolumeClaim')
      check(
        at(resource, 'spec', 'resources', 'requests', 'storage'),
        `${key}: storage request required`,
      );
  }
  for (const workload of workloads) {
    const label = `${String(workload.kind)}/${name(workload)}`;
    const pod = object(at(workload, 'spec', 'template', 'spec'));
    check(
      pod.automountServiceAccountToken === false,
      `${label}: service account token must be disabled`,
    );
    check(
      pod.terminationGracePeriodSeconds === 120,
      `${label}: shutdown grace must be 120 seconds`,
    );
    if (workload.kind === 'Job')
      check(at(workload, 'spec', 'activeDeadlineSeconds'), `${label}: deadline required`);
    else {
      check(at(workload, 'spec', 'replicas') === 1, `${label}: single replica required`);
      if (workload.kind === 'Deployment')
        check(
          at(workload, 'spec', 'strategy', 'type') === 'Recreate',
          `${label}: Recreate required`,
        );
    }
    if (workload.kind === 'StatefulSet')
      check(
        find('Service', at(workload, 'spec', 'serviceName')),
        `${label}: headless service missing`,
      );
    const volumes = list(pod.volumes);
    const claims = list(at(workload, 'spec', 'volumeClaimTemplates')).map((claim) =>
      at(claim, 'metadata', 'name'),
    );
    for (const volume of volumes) {
      if (volume.configMap)
        check(
          find('ConfigMap', at(volume, 'configMap', 'name')),
          `${label}: missing volume ConfigMap`,
        );
      if (volume.persistentVolumeClaim)
        check(
          find('PersistentVolumeClaim', at(volume, 'persistentVolumeClaim', 'claimName')),
          `${label}: missing PVC`,
        );
    }
    for (const container of list(pod.containers)) {
      const context = `${label}/${String(container.name)}`;
      check(
        at(container, 'resources', 'requests', 'memory') &&
          at(container, 'resources', 'limits', 'memory'),
        `${context}: resource bounds required`,
      );
      const ports = list(container.ports);
      for (const mount of list(container.volumeMounts))
        check(
          volumes.some((volume) => volume.name === mount.name) || claims.includes(mount.name),
          `${context}: undefined volume ${String(mount.name)}`,
        );
      for (const from of list(container.envFrom))
        if (from.configMapRef)
          check(
            find('ConfigMap', at(from, 'configMapRef', 'name')),
            `${context}: missing env ConfigMap`,
          );
      for (const env of list(container.env)) {
        const ref = object(at(env, 'valueFrom', 'secretKeyRef'));
        if (ref.name) {
          const secret = find('Secret', ref.name);
          check(
            secret && Object.hasOwn(object(secret.stringData), String(ref.key)),
            `${context}: missing Secret key ${String(ref.name)}/${String(ref.key)}`,
          );
          if (container.name !== 'init')
            check(
              ref.name !== 'ais-bootstrap',
              `${context}: bootstrap credentials leaked to runtime`,
            );
        }
      }
      if (workload.kind !== 'Job')
        for (const probe of ['startupProbe', 'livenessProbe', 'readinessProbe']) {
          check(container[probe], `${context}: ${probe} required`);
          const port =
            at(container, probe, 'httpGet', 'port') ?? at(container, probe, 'tcpSocket', 'port');
          if (port)
            check(
              ports.some((target) => target.containerPort === port || target.name === port),
              `${context}: ${probe} port unresolved`,
            );
        }
      const port = metrics[String(container.name)];
      if (port) {
        for (const probe of ['startupProbe', 'livenessProbe'])
          check(
            at(container, probe, 'httpGet', 'path') === '/metrics',
            `${context}: ${probe} must not depend on storage readiness`,
          );
        check(
          at(container, 'readinessProbe', 'httpGet', 'path') === '/ready' &&
            at(container, 'readinessProbe', 'httpGet', 'port') === port,
          `${context}: wrong readiness port/path`,
        );
        const key = ['api', 'collector', 'crawler'].includes(String(container.name))
          ? 'METRICS_PORT'
          : 'INTERNAL_METRICS_PORT';
        check(
          list(container.env).some((env) => env.name === key && env.value === String(port)),
          `${context}: wrong metrics environment`,
        );
      }
    }
  }
  for (const service of resources.filter((resource) => resource.kind === 'Service')) {
    const selector = object(at(service, 'spec', 'selector'));
    const targets = workloads.filter((workload) =>
      Object.entries(selector).every(
        ([key, value]) => at(workload, 'spec', 'template', 'metadata', 'labels', key) === value,
      ),
    );
    check(
      Object.keys(selector).length && targets.length,
      `Service/${name(service)}: selector matches no workload`,
    );
    const ports = targets.flatMap((target) =>
      list(at(target, 'spec', 'template', 'spec', 'containers')).flatMap((container) =>
        list(container.ports),
      ),
    );
    for (const port of list(at(service, 'spec', 'ports')))
      check(
        ports.some(
          (target) => target.containerPort === port.targetPort || target.name === port.targetPort,
        ),
        `Service/${name(service)}: targetPort unresolved`,
      );
  }
  for (const ingress of resources.filter((resource) => resource.kind === 'Ingress')) {
    const config = find('ConfigMap', 'ais-config');
    for (const rule of list(at(ingress, 'spec', 'rules'))) {
      check(
        rule.host === at(config, 'data', 'PUBLIC_DOMAIN'),
        'Ingress host must match PUBLIC_DOMAIN',
      );
      check(
        at(config, 'data', 'WEB_ORIGINS') === `https://${String(rule.host)}`,
        'WEB_ORIGINS must match HTTPS ingress',
      );
      for (const path of list(at(rule, 'http', 'paths'))) {
        const service = find('Service', at(path, 'backend', 'service', 'name'));
        check(
          service &&
            list(at(service, 'spec', 'ports')).some(
              (port) => port.port === at(path, 'backend', 'service', 'port', 'number'),
            ),
          'Ingress backend service/port unresolved',
        );
      }
    }
    // The cluster certificate workflow provisions this Secret separately.
    check(
      list(at(ingress, 'spec', 'tls')).every((tls) => tls.secretName === 'ais-ingress-tls'),
      'Ingress TLS Secret contract changed',
    );
  }
  const api = find('Deployment', 'api');
  const agent = find('Deployment', 'agent');
  const apiEnv = list(
    list(at(api, 'spec', 'template', 'spec', 'containers')).find(
      (container) => container.name === 'api',
    )?.env,
  );
  if (agent)
    for (const key of ['AGENT_ENABLED', 'AGENT_UI_ENABLED']) {
      check(
        apiEnv.some((env) => env.name === key && env.value === 'true'),
        `API must enable ${key} with Agent component`,
      );
      check(
        list(list(at(agent, 'spec', 'template', 'spec', 'containers'))[0]?.env).some(
          (env) => env.name === key && env.value === 'true',
        ),
        `Agent must enable ${key}`,
      );
    }
  if (api) {
    check(
      apiEnv.some((env) => env.name === 'API_HOST' && env.value === '127.0.0.1'),
      'API must bind loopback behind sidecar',
    );
    check(
      apiEnv.some(
        (env) => env.name === 'TRUSTED_PROXY_CIDRS' && env.value === '127.0.0.1/32,::1/128',
      ),
      'API must trust only loopback',
    );
  }
  const images = new Set(
    workloads.flatMap((workload) =>
      list(at(workload, 'spec', 'template', 'spec', 'containers'))
        .filter((container) => strings(container.command)[0] === 'node')
        .map((container) => container.image),
    ),
  );
  check(images.size <= 1, 'Application/init images must use the same version');
  return errors;
}

export function validateCompose(compose: RecordValue): string[] {
  const errors: string[] = [];
  const services = object(compose.services);
  for (const [name, raw] of Object.entries(services)) {
    const service = object(raw);
    if (name !== 'init' && !service.healthcheck)
      errors.push(`Compose/${name}: healthcheck required`);
    for (const dependency of Object.keys(object(service.depends_on)))
      if (!services[dependency]) errors.push(`Compose/${name}: missing dependency ${dependency}`);
    for (const volume of list(service.volumes)) {
      if (
        volume.type === 'volume' &&
        !Object.hasOwn(object(compose.volumes), String(volume.source))
      )
        errors.push(`Compose/${name}: missing named volume`);
      if (volume.type === 'bind' && !existsSync(String(volume.source)))
        errors.push(`Compose/${name}: missing bind source`);
    }
  }
  for (const [name, port] of Object.entries(metrics))
    if (
      services[name] &&
      !strings(at(services[name], 'healthcheck', 'test'))
        .join(' ')
        .includes(`:${port}/ready`)
    )
      errors.push(`Compose/${name}: wrong readiness port`);
  if (services.agent) {
    for (const key of ['AGENT_ENABLED', 'AGENT_UI_ENABLED'])
      if (at(services.api, 'environment', key) !== at(services.agent, 'environment', key))
        errors.push(`Compose: Agent/API ${key} mismatch`);
    if (at(services.agent, 'environment', 'INTERNAL_METRICS_PORT') !== '13110')
      errors.push('Compose: Agent metrics port must be 13110');
  }
  if (
    at(services.init, 'environment', 'S3_ACCESS_KEY_ID') ===
    at(services.api, 'environment', 'S3_ACCESS_KEY_ID')
  )
    errors.push('Compose: initialization and runtime S3 credentials must be separate');
  return errors;
}

export function checkDeployment(sourceOnly = false): string[] {
  const errors: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (/\.ya?ml$/.test(entry.name)) {
        const parsed = documents(readFileSync(path, 'utf8'));
        if (entry.name === 'kustomization.yaml')
          for (const target of [
            ...strings(parsed[0]?.resources),
            ...strings(parsed[0]?.components),
          ])
            if (!existsSync(resolve(dirname(path), target)))
              errors.push(`${path}: missing resource ${target}`);
      }
    }
  };
  visit(resolve(root, 'infra/k8s'));
  documents(read('infra/compose.production.yaml'));
  if (read('infra/nats.production.conf') !== read('infra/k8s/bootstrap/nats.conf'))
    errors.push('NATS Compose/Kubernetes configuration drift');
  if (
    read('infra/alerts.yaml').replace(/\r\n/g, '\n') !==
    read('infra/k8s/components/monitoring/alerts.yaml')
  )
    errors.push('Prometheus alert configuration drift');
  for (const path of [
    'infra/prometheus.production.yaml',
    'infra/k8s/components/monitoring/prometheus.yaml',
  ]) {
    const jobs = list(at(parse(read(path)), 'scrape_configs'));
    if (
      !jobs.some((job) =>
        list(job.dns_sd_configs).some(
          (dns) => strings(dns.names).includes('agent') && dns.port === 13110,
        ),
      )
    )
      errors.push(`${path}: optional Agent DNS discovery required`);
  }
  const caddy = read('infra/k8s/apps/Caddyfile');
  for (const expected of [
    'trusted_proxies_strict',
    'header_up X-Forwarded-For {client_ip}',
    'header_up X-Forwarded-Proto https',
    'reverse_proxy 127.0.0.1:13000',
    'reverse_proxy web:13001',
  ])
    if (!caddy.includes(expected)) errors.push(`Caddy sidecar missing ${expected}`);
  if (sourceOnly) return errors;
  // Explicit synthetic env-file; no inherited deployment values, real .env or kubeconfig.
  const env = { ...process.env };
  for (const match of read('infra/.env.production.example').matchAll(/^([A-Z][A-Z0-9_]*)=/gm))
    delete env[match[1]!];
  env.COMPOSE_DISABLE_ENV_FILE = '1';
  env.COMPOSE_PROFILES = '';
  env.KUBECONFIG = resolve(root, 'infra/k8s/.static-check-no-kubeconfig');
  const run = (command: string, args: string[], override: NodeJS.ProcessEnv = {}) => {
    const result = spawnSync(command, args, {
      cwd: root,
      encoding: 'utf8',
      env: { ...env, ...override },
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30_000,
      windowsHide: true,
    });
    if (result.error || result.status !== 0)
      throw new Error(
        `${command} static rendering failed: ${result.error?.message ?? result.stderr}`,
      );
    return result.stdout;
  };
  for (const profiles of [[], ['agent'], ['monitoring'], ['agent', 'monitoring']]) {
    const compose = object(
      JSON.parse(
        run(
          'docker',
          [
            'compose',
            '--env-file',
            'infra/.env.production.example',
            '-f',
            'infra/compose.production.yaml',
            ...profiles.flatMap((profile) => ['--profile', profile]),
            'config',
            '--format',
            'json',
          ],
          {
            AGENT_ENABLED: String(profiles.includes('agent')),
            AGENT_UI_ENABLED: String(profiles.includes('agent')),
          },
        ),
      ),
    );
    errors.push(
      ...validateCompose(compose).map((error) => `[${profiles.join('+') || 'base'}] ${error}`),
    );
    if (Boolean(at(compose, 'services', 'agent')) !== profiles.includes('agent'))
      errors.push('Compose Agent profile membership mismatch');
  }
  const render = (stage: string) =>
    documents(run('kubectl', ['kustomize', `infra/k8s/overlays/production/${stage}`]));
  const bootstrap = render('bootstrap'),
    init = render('init'),
    secrets = documents(read('infra/k8s/examples/secrets.example.yaml'));
  if (
    !String(
      at(
        init.find((resource) => resource.kind === 'Job'),
        'metadata',
        'name',
      ),
    ).match(/^ais-init-.+/)
  )
    errors.push('Initialization Job requires a versioned name');
  for (const stage of ['apps', 'apps-agent', 'apps-monitoring', 'apps-agent-monitoring']) {
    const apps = render(stage);
    errors.push(
      ...validateResources([...bootstrap, ...init, ...apps, ...secrets]).map(
        (error) => `[${stage}] ${error}`,
      ),
    );
    for (const name of [...Object.keys(metrics).filter((name) => name !== 'agent'), 'web'])
      if (
        !apps.some(
          (resource) => resource.kind === 'Deployment' && at(resource, 'metadata', 'name') === name,
        )
      )
        errors.push(`[${stage}] missing application ${name}`);
    if (
      apps.some((resource) => at(resource, 'metadata', 'name') === 'agent') !==
      stage.includes('agent')
    )
      errors.push(`[${stage}] Agent component membership mismatch`);
  }
  return errors;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const sourceOnly = process.argv.includes('--source-only');
    const errors = checkDeployment(sourceOnly);
    if (errors.length) {
      console.error(errors.join('\n'));
      process.exitCode = 1;
    } else
      console.log(
        sourceOnly
          ? 'Deployment source syntax checks passed (rendering skipped).'
          : 'Deployment checks passed: 4 Compose profiles and 6 Kustomize stages rendered; references, ports, probes and credentials checked. No daemon or cluster contacted.',
      );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
