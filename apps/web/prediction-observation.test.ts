import { expect, it } from 'vitest';
import { predictionInputObservation } from './app/utils/predictionObservation';
it('固定输入观测匹配MMSI和inputWindow.to，历史快照不被新fleet位置覆盖', () => {
  const record = {
    prediction: { mmsi: '123456789', inputWindow: { to: '2026-10-24T00:00:00Z' } },
    evidence: {
      ais: [
        {
          recordId: 'input',
          mmsi: '123456789',
          occurredAt: '2026-10-24T00:00:00.000Z',
          longitude: 123,
          latitude: 34,
          speedOverGround: 10,
          courseOverGround: 60,
          raw: { quality: ['synthetic'] },
        },
      ],
    },
  };
  const fleet = [{ kind: 'point' as const, mmsi: '123456789', lon: 130, lat: 40 }];
  expect(predictionInputObservation(record, fleet as never)).toMatchObject({
    lon: 123,
    lat: 34,
    observedAt: '2026-10-24T00:00:00.000Z',
    quality: ['synthetic'],
  });
  expect(predictionInputObservation(record)).toMatchObject({ lon: 123, lat: 34 });
  expect(
    predictionInputObservation({ ...record, evidence: { ais: [] } }, fleet as never),
  ).toMatchObject({ lon: 130, lat: 40 });
});
