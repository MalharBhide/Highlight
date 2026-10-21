import test from 'node:test';
import assert from 'node:assert/strict';
import { parseByteRange } from './httpRange.ts';

test('media byte ranges support seeks, open-ended requests, and suffixes', () => {
  assert.deepEqual(parseByteRange('bytes=10-19', 100), { start: 10, end: 19 });
  assert.deepEqual(parseByteRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseByteRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseByteRange('bytes=0-999', 100), { start: 0, end: 99 });
  for (const range of ['bytes=100-', 'bytes=20-10', 'bytes=-0', 'bytes=-', 'garbage', 'bytes=0-1,5-6']) {
    assert.equal(parseByteRange(range, 100), null, range);
  }
});
