import path from 'node:path';
import type { GoogleGenAI, Schema } from '@google/genai';

/** Send actual audio/video to Gemini and remove the temporary remote file afterwards. */
export async function analyzeVideoFile(
  ai: Pick<GoogleGenAI, 'files' | 'models'>,
  sourcePath: string,
  prompt: string,
  responseSchema: Schema,
  options: { model?: string; processingTimeoutMs?: number; pollIntervalMs?: number } = {}
): Promise<unknown> {
  const mimeTypes: Record<string, string> = {
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
    '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  };
  let uploadedName: string | undefined;
  try {
    let uploaded = await ai.files.upload({
      file: sourcePath,
      config: {
        mimeType: mimeTypes[path.extname(sourcePath).toLowerCase()] || 'video/mp4',
        httpOptions: { timeout: 120000 },
      },
    });
    uploadedName = uploaded.name;
    if (!uploadedName) throw new Error('Gemini upload returned no file name.');
    const deadline = Date.now() + (options.processingTimeoutMs ?? 180000);
    while (uploaded.state === 'PROCESSING' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs ?? 2000));
      uploaded = await ai.files.get({ name: uploadedName, config: { httpOptions: { timeout: 15000 } } });
    }
    if (uploaded.state !== 'ACTIVE' || !uploaded.uri || !uploaded.mimeType) {
      throw new Error('Gemini video processing failed or timed out.');
    }
    const response = await ai.models.generateContent({
      model: options.model || process.env.GEMINI_MODEL || 'gemini-3.8-flash',
      contents: [{ role: 'user', parts: [
        { fileData: { fileUri: uploaded.uri, mimeType: uploaded.mimeType } },
        { text: prompt },
      ] }],
      config: { responseMimeType: 'application/json', responseSchema, httpOptions: { timeout: 120000 } },
    });
    if (!response.text) throw new Error('Gemini returned an empty analysis.');
    return JSON.parse(response.text);
  } finally {
    if (uploadedName) {
      await ai.files.delete({ name: uploadedName, config: { httpOptions: { timeout: 10000 } } }).catch(() => {});
    }
  }
}
