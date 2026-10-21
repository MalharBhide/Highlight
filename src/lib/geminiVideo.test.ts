import test from 'node:test';
import assert from 'node:assert/strict';
import { Type, type GoogleGenAI } from '@google/genai';
import { analyzeVideoFile } from './geminiVideo.ts';

function mockClient(state: string = 'PROCESSING', response = '{"highlights":[]}') {
  const calls: Record<string, any[]> = { upload: [], get: [], generate: [], delete: [] };
  const file = { name: 'files/test', uri: 'https://example.invalid/video', mimeType: 'video/webm' };
  const ai = {
    files: {
      upload: async (args: unknown) => { calls.upload.push(args); return { ...file, state }; },
      get: async (args: unknown) => { calls.get.push(args); return { ...file, state: 'ACTIVE' }; },
      delete: async (args: unknown) => { calls.delete.push(args); },
    },
    models: { generateContent: async (args: unknown) => { calls.generate.push(args); return { text: response }; } },
  } as unknown as Pick<GoogleGenAI, 'files' | 'models'>;
  return { ai, calls };
}

test('Gemini waits for video processing, sends file data, and deletes the uploaded file', async () => {
  const { ai, calls } = mockClient();
  await analyzeVideoFile(ai, '/tmp/input.webm', 'Find highlights', { type: Type.OBJECT }, { pollIntervalMs: 0 });
  assert.equal(calls.upload[0].config.mimeType, 'video/webm');
  assert.equal(calls.get.length, 1);
  assert.deepEqual(calls.generate[0].contents[0].parts[0], {
    fileData: { fileUri: 'https://example.invalid/video', mimeType: 'video/webm' },
  });
  assert.equal(calls.delete[0].name, 'files/test');
});

test('Gemini errors and malformed JSON propagate and still clean up remote media', async () => {
  for (const [state, response] of [['FAILED', '{}'], ['ACTIVE', 'invalid JSON'], ['PROCESSING', '{}']]) {
    const { ai, calls } = mockClient(state, response);
    await assert.rejects(analyzeVideoFile(ai, '/tmp/input.mp4', 'Find highlights', { type: Type.OBJECT }, { processingTimeoutMs: 0 }));
    assert.equal(calls.delete.length, 1);
  }
});
