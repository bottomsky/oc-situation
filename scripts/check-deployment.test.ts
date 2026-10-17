import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documents, validateResources } from './check-deployment.js';

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
