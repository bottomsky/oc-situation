import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'vitest';
import { documents, validateResources } from './check-deployment.js';

test('ships enabled model thinking with configurable Compose and Kubernetes settings', () => {
  for (const path of ['../.env.example', '../infra/.env.production.example'])
    assert.match(
      readFileSync(new URL(path, import.meta.url), 'utf8'),
      /^AGENT_THINKING_LEVEL=high$/m,
    );
  const compose = documents(
    readFileSync(new URL('../infra/compose.production.yaml', import.meta.url), 'utf8'),
  )[0]!;
  assert.equal(
    (compose.services as Record<string, { environment: Record<string, string> }>).agent!.environment
      .AGENT_THINKING_LEVEL,
    '${AGENT_THINKING_LEVEL:-high}',
  );
  const config = documents(
    readFileSync(new URL('../infra/k8s/bootstrap/config.yaml', import.meta.url), 'utf8'),
  )[0]!;
  assert.equal((config.data as Record<string, string>).AGENT_THINKING_LEVEL, 'high');
  const agent = documents(
    readFileSync(new URL('../infra/k8s/components/agent/agent.yaml', import.meta.url), 'utf8'),
  )[0]!;
  const spec = agent.spec as {
    template: { spec: { containers: { env: { name: string; valueFrom?: unknown }[] }[] } };
  };
  assert.deepEqual(
    spec.template.spec.containers[0]!.env.find((env) => env.name === 'AGENT_THINKING_LEVEL')
      ?.valueFrom,
    { configMapKeyRef: { name: 'ais-config', key: 'AGENT_THINKING_LEVEL' } },
  );
});

const fixture = `
apiVersion: apps/v1
kind: Deployment
metadata: {name: processor, namespace: ais-platform}
spec:
  replicas: 1
  strategy: {type: Recreate}
  template:
    metadata:
      labels: {app: processor}
    spec:
      automountServiceAccountToken: false
      terminationGracePeriodSeconds: 120
      containers:
        - name: processor
          image: example.invalid/ais:test
          command: [node, apps/processor/dist/main.mjs]
          env:
            - {name: INTERNAL_METRICS_PORT, value: '13101'}
            - name: DATABASE_URL
              valueFrom: {secretKeyRef: {name: ais-runtime, key: DATABASE_URL}}
          ports: [{name: metrics, containerPort: 13101}]
          resources:
            requests: {memory: 256Mi}
            limits: {memory: 1Gi}
          startupProbe: {httpGet: {path: /metrics, port: 13101}}
          livenessProbe: {httpGet: {path: /metrics, port: 13101}}
          readinessProbe: {httpGet: {path: /ready, port: 13101}}
---
apiVersion: v1
kind: Secret
metadata: {name: ais-runtime, namespace: ais-platform}
stringData: {DATABASE_URL: synthetic}
---
apiVersion: v1
kind: Service
metadata: {name: processor, namespace: ais-platform}
spec:
  selector: {app: processor}
  ports: [{port: 13101, targetPort: metrics}]
`;

test('accepts a fully resolved workload', () => {
  assert.deepEqual(validateResources(documents(fixture)), []);
});
test('rejects missing Secret keys', () => {
  const resources = documents(fixture);
  resources[1]!.stringData = {};
  assert.ok(validateResources(resources).some((error) => error.includes('missing Secret key')));
});
test('rejects Service targets with no declared container port', () => {
  assert.ok(
    validateResources(documents(fixture.replace('targetPort: metrics', 'targetPort: 9999'))).some(
      (error) => error.includes('targetPort unresolved'),
    ),
  );
});
test('rejects storage readiness as process liveness', () => {
  assert.ok(
    validateResources(
      documents(
        fixture.replace(
          'livenessProbe: {httpGet: {path: /metrics',
          'livenessProbe: {httpGet: {path: /ready',
        ),
      ),
    ).some((error) => error.includes('livenessProbe must not depend')),
  );
});
test('rejects runtime access to initialization credentials', () => {
  assert.ok(
    validateResources(documents(fixture.replaceAll('ais-runtime', 'ais-bootstrap'))).some((error) =>
      error.includes('bootstrap credentials leaked'),
    ),
  );
});
test('rejects mixed application and initialization image versions', () => {
  const resources = documents(fixture);
  const duplicate = documents(
    fixture
      .replace('name: processor, namespace:', 'name: processor-other, namespace:')
      .replace('example.invalid/ais:test', 'example.invalid/ais:other'),
  )[0]!;
  assert.ok(
    validateResources([...resources, duplicate]).some((error) => error.includes('same version')),
  );
});

const predictionFixture = fixture
  .replaceAll('processor', 'topic-predictions')
  .replace('apps/topic-predictions/dist/main.mjs', 'apps/topics/dist/main.mjs')
  .replaceAll('13101', '13111')
  .replace(
    "- {name: INTERNAL_METRICS_PORT, value: '13111'}",
    "- {name: INTERNAL_METRICS_PORT, value: '13111'}\n            - {name: TOPIC_PREDICTIONS_ONLY, value: 'true'}",
  )
  .replace('limits: {memory: 1Gi}', "limits: {cpu: '2', memory: 2Gi}");

test('requires the prediction-only worker mode and aligned resource limits', () => {
  assert.deepEqual(validateResources(documents(predictionFixture)), []);
  assert.ok(
    validateResources(
      documents(predictionFixture.replace("- {name: TOPIC_PREDICTIONS_ONLY, value: 'true'}", '')),
    ).some((error) => error.includes('TOPIC_PREDICTIONS_ONLY')),
  );
  assert.ok(
    validateResources(
      documents(
        predictionFixture.replace(
          "limits: {cpu: '2', memory: 2Gi}",
          "limits: {cpu: '1', memory: 1Gi}",
        ),
      ),
    ).some((error) => error.includes('prediction resource limits')),
  );
});

test('checks prediction metrics readiness instead of treating the new worker as unknown', () => {
  assert.ok(
    validateResources(
      documents(
        predictionFixture.replace(
          "INTERNAL_METRICS_PORT, value: '13111'",
          "INTERNAL_METRICS_PORT, value: '13109'",
        ),
      ),
    ).some((error) => error.includes('wrong metrics environment')),
  );
});

test('registers the prediction workload and metrics service in the shared apps base', () => {
  const resource = new URL('../infra/k8s/apps/topic-predictions.yaml', import.meta.url);
  assert.ok(existsSync(resource), 'Prediction Kubernetes workload is required');
  const resources = documents(readFileSync(resource, 'utf8'));
  assert.deepEqual(
    resources.map((r) => [r.kind, (r.metadata as { name: string }).name]),
    [
      ['Deployment', 'topic-predictions'],
      ['Service', 'topic-predictions'],
    ],
  );
  const kustomization = documents(
    readFileSync(new URL('../infra/k8s/apps/kustomization.yaml', import.meta.url), 'utf8'),
  )[0]!;
  assert.ok((kustomization.resources as string[]).includes('topic-predictions.yaml'));
});

test('scrapes prediction worker metrics in both production monitoring configurations', () => {
  for (const path of [
    '../infra/prometheus.production.yaml',
    '../infra/k8s/components/monitoring/prometheus.yaml',
  ]) {
    const config = documents(readFileSync(new URL(path, import.meta.url), 'utf8'))[0]!;
    const jobs = config.scrape_configs as { static_configs?: { targets: string[] }[] }[];
    assert.ok(
      jobs.some((job) =>
        job.static_configs?.some((entry) => entry.targets.includes('topic-predictions:13111')),
      ),
      `${path}: prediction scrape target missing`,
    );
  }
});
