import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { assertReplayCapture } from './replay';

it('requires declared source, hash-named original file and exact bytes', () => {
  const bytes = Buffer.from('actual-original-bytes');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const capture = {
    file: `zhejiang-maritime-${sha256}.raw`,
    sha256,
    url: 'https://www.zj.msa.gov.cn/ZJ/wszw/bmcx/hsskcx/hxjg/202610/t20261008_21435.html',
  };
  expect(() => assertReplayCapture('zhejiang-maritime', capture, bytes)).not.toThrow();
  expect(() => assertReplayCapture('zhejiang-maritime', capture, Buffer.from('changed'))).toThrow(
    'checksum',
  );
  expect(() =>
    assertReplayCapture('zhejiang-maritime', { ...capture, file: '../secret.raw' }, bytes),
  ).toThrow('filename');
  expect(() =>
    assertReplayCapture(
      'zhejiang-maritime',
      { ...capture, url: 'https://evil.example/doc' },
      bytes,
    ),
  ).toThrow('hosts');
  expect(() => assertReplayCapture('unknown-source', capture, bytes)).toThrow('preset');
});
