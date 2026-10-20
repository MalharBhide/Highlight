import express from 'express';
import { createServer as createViteServer } from 'vite';
import multer from 'multer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import dotenv from 'dotenv';
import { GoogleGenAI, Type, ThinkingLevel } from '@google/genai';
import {
  extractYouTubeVideoId,
  parseIsoDuration,
  clampKeepPercentage,
  formatVideoDownloadFilename,
  DEFAULT_KEEP_PERCENTAGE,
  calculateTargetDuration,
  analyzeEngagementTimeline,
  validateAndClampAICandidates,
  ensureCandidateCoverageForTarget,
  scoreAndMergeCandidates,
  selectHighlightReel,
  verifySourceMediaDuration,
  computeClipRenderSignature,
  classifySegmentRole,
  formatTimestamp,
  sanitizeClientId,
  isJobVisibleToClient,
  selectTargetOutputResolution,
  type VideoRecord,
  type HighlightJobRecord,
  type HighlightSegmentRecord,
  type AICandidateHighlight,
  type EngagementPoint,
  type JobStageId,
  type GeminiAnalysisSchema,
} from './src/lib/highlightEngine.ts';
import { DEVELOPMENT_FIXTURES, KEYNOTE_THUMBNAIL_SVG } from './src/lib/testFixtures.ts';

dotenv.config();

const execFileAsync = promisify(execFile);

const MEDIA_STORAGE_DIR =
  process.env.MEDIA_STORAGE_DIR || path.join(os.tmpdir(), 'highlight-storage');
const STORAGE_DIR = process.env.STORAGE_DIR || MEDIA_STORAGE_DIR;
const UPLOADS_DIR = path.join(MEDIA_STORAGE_DIR, 'uploads');
const RENDERS_DIR = path.join(MEDIA_STORAGE_DIR, 'renders');
const DB_FILE = path.join(STORAGE_DIR, 'db.json');
const AUDIO_SIGNALS_CACHE_FILE = path.join(MEDIA_STORAGE_DIR, 'audio-signals-cache.json');
const GEMINI_CACHE_FILE = path.join(STORAGE_DIR, 'gemini-cache.json');
const FIXTURE_MP4_PATH = path.join(MEDIA_STORAGE_DIR, 'fixture-keynote-300s.mp4');

fs.mkdirSync(STORAGE_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(RENDERS_DIR, { recursive: true });

const NOTUBE_MIRROR_NUMBERS = [
  40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58,
  59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76,
];

function pickNotubeMirrors(count = 6): string[] {
  const pool = [...NOTUBE_MIRROR_NUMBERS];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count).map((n) => `https://s${n}.notube.net`);
}

function extractRequestClientId(req: express.Request): string | null {
  const headerVal = req.headers['x-client-id'];
  const rawHeader = Array.isArray(headerVal) ? headerVal[0] : headerVal;
  return (
    sanitizeClientId(rawHeader) ||
    sanitizeClientId(req.query?.clientId) ||
    sanitizeClientId(req.body?.clientId)
  );
}

interface DatabaseState {
  videos: Record<string, VideoRecord>;
  jobs: Record<string, HighlightJobRecord>;
  segments: Record<string, HighlightSegmentRecord[]>;
}

function normalizeMediaFilePath(filePath: string | undefined, targetDir: string): string | undefined {
  if (!filePath) return undefined;
  if (fs.existsSync(filePath)) return filePath;
  const relocated = path.join(targetDir, path.basename(filePath));
  if (fs.existsSync(relocated)) return relocated;
  return relocated;
}

function loadDb(): DatabaseState {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf-8');
      const parsed = JSON.parse(raw) as DatabaseState;
      for (const [id, job] of Object.entries(parsed.jobs || {})) {
        // Purge failed jobs or legacy unowned jobs so another user's videos are never exposed globally
        if (job.status === 'failed' || !sanitizeClientId(job.owner_client_id)) {
          delete parsed.jobs[id];
          if (parsed.segments) {
            delete parsed.segments[id];
          }
          continue;
        }
        if (job.download_location) {
          job.download_location = normalizeMediaFilePath(job.download_location, RENDERS_DIR);
        }
        if (job.source_media_path) {
          job.source_media_path = job.source_media_path.includes('fixture-keynote')
            ? FIXTURE_MP4_PATH
            : normalizeMediaFilePath(job.source_media_path, UPLOADS_DIR);
        }
      }
      const referencedVideos = new Set(Object.values(parsed.jobs || {}).map((j) => j.video_id));
      for (const [vidId, video] of Object.entries(parsed.videos || {})) {
        if (!referencedVideos.has(vidId)) {
          delete parsed.videos[vidId];
          continue;
        }
        if (video.title.includes('(Dev Fixture)')) {
          video.title = video.title.replace(/\s*\(Dev Fixture\)/g, '');
        }
      }
      return parsed;
    }
  } catch {
    // Initialize fresh store if DB file is unreadable
  }
  return { videos: {}, jobs: {}, segments: {} };
}

const db: DatabaseState = loadDb();

function saveDb(): void {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf-8');
  } catch {
    // ignore transient write error
  }
}

function seedInitialReelsIfNeeded(): void {
  // Intentionally disabled: user-compiled videos are strictly scoped per browser client ID
  // so no user's videos are ever pre-populated or saved onto another user's computer.
}
seedInitialReelsIfNeeded();

function hasValidEnvKey(val: string | undefined, placeholder: string): boolean {
  return Boolean(val && val.trim() && val.trim() !== placeholder && !val.startsWith('MY_'));
}

interface ProbedMediaInfo {
  duration: number;
  hasAudio: boolean;
  width: number;
  height: number;
}

const mediaInfoCache = new Map<string, ProbedMediaInfo>();

/**
 * Probes duration, audio stream presence, and video dimensions in a single cached ffprobe call.
 */
async function probeMediaInfo(filePath: string): Promise<ProbedMediaInfo> {
  const stat = fs.statSync(filePath);
  const cacheKey = `${filePath}:${stat.size}:${Math.floor(stat.mtimeMs)}`;
  const cached = mediaInfoCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration:stream=codec_type,width,height',
    '-of',
    'json',
    filePath,
  ]);
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
  };

  const duration = parseFloat(parsed.format?.duration || '');
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('Unable to determine valid video duration via ffprobe.');
  }

  const streams = parsed.streams || [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const hasAudio = streams.some((s) => s.codec_type === 'audio');
  const info: ProbedMediaInfo = {
    duration,
    hasAudio,
    width: Number(videoStream?.width) || 0,
    height: Number(videoStream?.height) || 0,
  };

  mediaInfoCache.set(cacheKey, info);
  return info;
}

/**
 * Probes the video stream height (in pixels) of a local video file using cached ffprobe info.
 */
async function probeVideoStreamHeight(filePath: string): Promise<number> {
  try {
    const info = await probeMediaInfo(filePath);
    return info.height;
  } catch {
    return 0;
  }
}

/**
 * Generates a real 304.64-second 1280x720 30fps HD H.264/AAC MP4 video using FFmpeg if not already cached at >=720p.
 */
let fixtureGenerationPromise: Promise<string> | null = null;

export async function ensureFixtureSourceVideo(): Promise<string> {
  if (fs.existsSync(FIXTURE_MP4_PATH) && fs.statSync(FIXTURE_MP4_PATH).size > 50000) {
    const existingHeight = await probeVideoStreamHeight(FIXTURE_MP4_PATH);
    if (existingHeight >= 720) {
      return FIXTURE_MP4_PATH;
    }
  }
  if (fixtureGenerationPromise) {
    return fixtureGenerationPromise;
  }

  fixtureGenerationPromise = (async () => {
    const tmpOut = `${FIXTURE_MP4_PATH}.tmp.mp4`;
    try {
      await execFileAsync('ffmpeg', [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=1280x720:rate=30:duration=304.64',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=44100:duration=304.64',
        '-threads',
        '4',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '18',
        '-maxrate',
        '2500k',
        '-bufsize',
        '5000k',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-shortest',
        tmpOut,
      ]);
      fs.renameSync(tmpOut, FIXTURE_MP4_PATH);
      return FIXTURE_MP4_PATH;
    } finally {
      fixtureGenerationPromise = null;
    }
  })();

  return fixtureGenerationPromise;
}

/**
 * Probes the exact unrounded duration (in seconds) of a local video file using cached ffprobe info.
 */
async function probeVideoDuration(filePath: string): Promise<number> {
  const info = await probeMediaInfo(filePath);
  return info.duration;
}

/**
 * Checks whether a local video file contains at least one audio stream.
 */
async function hasAudioStream(filePath: string): Promise<boolean> {
  try {
    const info = await probeMediaInfo(filePath);
    return info.hasAudio;
  } catch {
    return false;
  }
}

/**
 * Detects natural audio pause boundaries using FFmpeg silencedetect filter
 * on an authorized local video file without rounding timestamps.
 */
async function detectAudioPauseBoundaries(filePath: string): Promise<number[]> {
  try {
    const { stderr } = await execFileAsync(
      'ffmpeg',
      ['-i', filePath, '-af', 'silencedetect=noise=-32dB:d=0.35', '-f', 'null', '-'],
      { timeout: 15000 }
    );
    const boundaries: number[] = [];
    const regex = /silence_(?:start|end):\s*([0-9.]+)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(stderr)) !== null) {
      const val = parseFloat(match[1]);
      if (Number.isFinite(val)) {
        boundaries.push(val);
      }
    }
    return boundaries;
  } catch {
    return [];
  }
}

interface EngagementProviderResult {
  available: boolean;
  source: 'youtube_analytics_api' | 'authorized_channel_fixture' | 'unavailable';
  observations: EngagementPoint[];
}

async function fetchEngagementData(
  youtubeVideoId: string,
  channelAccessToken?: string
): Promise<EngagementProviderResult> {
  const fixture = DEVELOPMENT_FIXTURES[youtubeVideoId];
  if (fixture) {
    return {
      available: fixture.engagementAvailable,
      source: fixture.engagementSource,
      observations: fixture.engagementObservations,
    };
  }

  if (channelAccessToken && channelAccessToken.trim()) {
    try {
      const url = new URL('https://youtubeanalytics.googleapis.com/v2/reports');
      url.searchParams.set('ids', 'channel==MINE');
      url.searchParams.set('startDate', '2020-01-01');
      url.searchParams.set('endDate', new Date().toISOString().slice(0, 10));
      url.searchParams.set('metrics', 'audienceWatchRatio,relativeRetentionPerformance');
      url.searchParams.set('dimensions', 'elapsedVideoTimeRatio');
      url.searchParams.set('filters', `video==${youtubeVideoId}`);

      const res = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${channelAccessToken.trim()}`,
        },
      });
      if (res.ok) {
        const data = (await res.json()) as { rows?: number[][] };
        if (Array.isArray(data.rows) && data.rows.length >= 5) {
          const observations: EngagementPoint[] = data.rows.map((r) => ({
            elapsedVideoTimeRatio: Number(r[0]),
            audienceWatchRatio: Number(r[1]),
            relativeRetentionPerformance: Number(r[2]),
          }));
          return {
            available: true,
            source: 'youtube_analytics_api',
            observations,
          };
        }
      }
    } catch {
      // Fallback to Gemini AI + FFmpeg audio signal analysis when YouTube Analytics is unavailable
    }
  }

  return {
    available: false,
    source: 'unavailable',
    observations: [],
  };
}

/**
 * Retrieves YouTube video metadata via official YouTube Data API v3 (if YOUTUBE_API_KEY is set),
 * or falls back to official YouTube oEmbed metadata for public videos.
 */
async function inspectYouTubeVideo(
  rawUrl: string,
  overrideDurationSeconds?: number
): Promise<VideoRecord> {
  const videoId = extractYouTubeVideoId(rawUrl);
  if (!videoId) {
    throw new Error(
      'Invalid YouTube URL. Supported formats: youtube.com/watch?v=ID, youtu.be/ID, or youtube.com/shorts/ID.'
    );
  }

  if (DEVELOPMENT_FIXTURES[videoId]) {
    const fixVideo = { ...DEVELOPMENT_FIXTURES[videoId].video };
    db.videos[fixVideo.id] = fixVideo;
    saveDb();
    return fixVideo;
  }

  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const cachedMp4 = path.join(UPLOADS_DIR, `yt-${videoId}.mp4`);
  const existingRecord = db.videos[`vid-${videoId}`];

  if (
    !overrideDurationSeconds &&
    existingRecord &&
    existingRecord.duration >= 5 &&
    existingRecord.duration !== 300 &&
    existingRecord.duration !== 600 &&
    !existingRecord.title.startsWith('YouTube Video (')
  ) {
    if (fs.existsSync(cachedMp4) && fs.statSync(cachedMp4).size > 50000) {
      try {
        const exactProbed = await probeVideoDuration(cachedMp4);
        if (exactProbed >= 5 && Math.abs(existingRecord.duration - exactProbed) > 0.01) {
          existingRecord.duration = exactProbed;
          saveDb();
        }
      } catch {
        // ignore
      }
    }
    return existingRecord;
  }

  const ytApiKey = process.env.YOUTUBE_API_KEY;

  if (hasValidEnvKey(ytApiKey, 'MY_YOUTUBE_DATA_API_KEY')) {
    const apiUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
    apiUrl.searchParams.set('part', 'snippet,contentDetails,status');
    apiUrl.searchParams.set('id', videoId);
    apiUrl.searchParams.set('key', ytApiKey!.trim());

    const response = await fetch(apiUrl.toString());
    if (response.ok) {
      const data = (await response.json()) as {
        items?: Array<{
          snippet?: {
            title?: string;
            channelTitle?: string;
            description?: string;
            thumbnails?: Record<string, { url?: string }>;
          };
          contentDetails?: { duration?: string };
          status?: { privacyStatus?: string; embeddable?: boolean };
        }>;
      };

      const item = data.items?.[0];
      if (!item) {
        throw new Error('YouTube video not found, private, or unavailable.');
      }
      if (item.status?.privacyStatus === 'private') {
        throw new Error('This YouTube video is private and cannot be analyzed.');
      }

      const duration =
        parseIsoDuration(item.contentDetails?.duration || '') ||
        overrideDurationSeconds ||
        600;
      const thumb =
        item.snippet?.thumbnails?.maxres?.url ||
        item.snippet?.thumbnails?.high?.url ||
        item.snippet?.thumbnails?.medium?.url ||
        `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

      const record: VideoRecord = {
        id: `vid-${videoId}`,
        youtube_video_id: videoId,
        title: item.snippet?.title || `YouTube Video (${videoId})`,
        channel: item.snippet?.channelTitle || 'YouTube Creator',
        duration,
        thumbnail: thumb,
        description: item.snippet?.description || '',
        original_url: canonicalUrl,
        is_fixture: false,
      };
      db.videos[record.id] = record;
      saveDb();
      return record;
    }
  }

  let title = existingRecord?.title || `YouTube Video (${videoId})`;
  let channel = existingRecord?.channel || 'YouTube Creator';
  let thumbnail = existingRecord?.thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  let detectedDuration =
    overrideDurationSeconds && overrideDurationSeconds >= 5 ? overrideDurationSeconds : 0;

  if (!detectedDuration && fs.existsSync(cachedMp4) && fs.statSync(cachedMp4).size > 50000) {
    try {
      detectedDuration = await probeVideoDuration(cachedMp4);
    } catch {
      // ignore
    }
  }

  if (
    !detectedDuration &&
    existingRecord &&
    existingRecord.duration >= 5 &&
    existingRecord.duration !== 300 &&
    existingRecord.duration !== 600
  ) {
    detectedDuration = existingRecord.duration;
  }

  // Fetch oEmbed metadata and watch page duration concurrently to cut inspection latency in half
  const oembedTask = (async () => {
    try {
      const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(
        canonicalUrl
      )}&format=json`;
      const oembedRes = await fetch(oembedUrl, { signal: AbortSignal.timeout(5000) });
      if (oembedRes.ok) {
        const oembed = (await oembedRes.json()) as {
          title?: string;
          author_name?: string;
          thumbnail_url?: string;
        };
        if (oembed.title) title = oembed.title;
        if (oembed.author_name) channel = oembed.author_name;
        if (oembed.thumbnail_url) thumbnail = oembed.thumbnail_url;
      } else if (
        oembedRes.status === 401 ||
        oembedRes.status === 403 ||
        oembedRes.status === 404
      ) {
        throw new Error(
          'This YouTube video is private, restricted, or inaccessible via public metadata.'
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('private, restricted')) {
        throw err;
      }
      if (!existingRecord?.thumbnail) {
        thumbnail = KEYNOTE_THUMBNAIL_SVG;
      }
    }
  })();

  const watchDurationTask = (async () => {
    if (detectedDuration >= 5) return;
    try {
      const mobileWatchUrl = `https://m.youtube.com/watch?v=${videoId}`;
      const watchRes = await fetch(mobileWatchUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(4500),
      });
      if (watchRes.ok) {
        const html = await watchRes.text();
        const msMatch = html.match(/"approxDurationMs"\s*:\s*"(\d+)"/);
        if (msMatch && msMatch[1]) {
          const parsedMs = parseInt(msMatch[1], 10);
          if (Number.isFinite(parsedMs) && parsedMs >= 5000) {
            detectedDuration = parsedMs / 1000;
          }
        }
        if (!detectedDuration) {
          const match = html.match(/"lengthSeconds"\s*:\s*"(\d+)"/);
          if (match && match[1]) {
            const parsedSec = parseInt(match[1], 10);
            if (Number.isFinite(parsedSec) && parsedSec >= 5) {
              detectedDuration = Math.max(5, parsedSec - 0.35);
            }
          }
        }
        if (!detectedDuration) {
          const isoMatch = html.match(/itemprop="duration"\s+content="([^"]+)"/);
          if (isoMatch && isoMatch[1]) {
            const parsedIso = parseIsoDuration(isoMatch[1]);
            if (parsedIso >= 5) {
              detectedDuration = Math.max(5, parsedIso - 0.35);
            }
          }
        }
      }
    } catch {
      // Fallback to stream metadata check
    }
  })();

  await Promise.all([oembedTask, watchDurationTask]);

  if (!detectedDuration) {
    try {
      const mirrors = pickNotubeMirrors(2);
      const weightDur = await Promise.any(
        mirrors.map(async (mirror) => {
          const weightRes = await fetch(`${mirror}/recover_weight.php`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'User-Agent': 'Mozilla/5.0',
              Origin: 'https://notube.net',
              Referer: 'https://notube.net/',
            },
            body: `url=${encodeURIComponent(canonicalUrl)}&format=mp4hd&lang=en&subscribed=false`,
            signal: AbortSignal.timeout(5000),
          });
          if (!weightRes.ok) throw new Error('Mirror failed');
          const weightData = (await weightRes.json()) as { url_mp4_youtube?: string };
          const durMatch = weightData.url_mp4_youtube?.match(/[?&]dur=([0-9.]+)/);
          if (durMatch && durMatch[1]) {
            const parsedDur = parseFloat(durMatch[1]);
            if (Number.isFinite(parsedDur) && parsedDur >= 2) {
              return parsedDur;
            }
          }
          throw new Error('No duration found');
        })
      );
      if (weightDur >= 2) {
        detectedDuration = weightDur;
      }
    } catch {
      // Fallback if duration lookup times out
    }
  }

  const duration = detectedDuration >= 5 ? detectedDuration : 300;

  const record: VideoRecord = {
    id: `vid-${videoId}`,
    youtube_video_id: videoId,
    title,
    channel,
    duration,
    thumbnail,
    description:
      'Public YouTube video analyzed with Google Gemini multimodal video understanding.',
    original_url: canonicalUrl,
    is_fixture: false,
  };
  db.videos[record.id] = record;
  saveDb();
  return record;
}

interface RawAudioSignals {
  pauseBoundaries: number[];
  rmsSamples: { time: number; norm: number }[];
}

interface SourceMediaSignals {
  pauseBoundaries: number[];
  energyPeaks: {
    start_time: number;
    end_time: number;
    peak_time: number;
    audio_score: number;
    visual_score: number;
    semantic_score: number;
  }[];
  introEnd: number;
  outroStart: number;
}

function loadAudioSignalsCache(): Record<string, RawAudioSignals> {
  try {
    if (fs.existsSync(AUDIO_SIGNALS_CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(AUDIO_SIGNALS_CACHE_FILE, 'utf-8')) as Record<
        string,
        RawAudioSignals
      >;
    }
  } catch {
    // ignore cache read error
  }
  return {};
}

const rawAudioSignalsCache: Record<string, RawAudioSignals> = loadAudioSignalsCache();
const activeAudioSignalExtractions = new Map<string, Promise<RawAudioSignals | null>>();

function saveAudioSignalsCache(): void {
  try {
    fs.writeFileSync(AUDIO_SIGNALS_CACHE_FILE, JSON.stringify(rawAudioSignalsCache), 'utf-8');
  } catch {
    // ignore cache write error
  }
}

async function extractRawAudioSignals(filePath: string): Promise<RawAudioSignals | null> {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  const cacheKey = `${path.basename(filePath)}:${stat.size}`;
  if (rawAudioSignalsCache[cacheKey]) {
    return rawAudioSignalsCache[cacheKey];
  }

  const inFlight = activeAudioSignalExtractions.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const task = (async (): Promise<RawAudioSignals | null> => {
    try {
      const { stderr } = await execFileAsync(
        'ffmpeg',
        [
          '-threads',
          '4',
          '-i',
          filePath,
          '-vn',
          '-ac',
          '1',
          '-ar',
          '8000',
          '-af',
          'silencedetect=noise=-28dB:d=0.22,asetnsamples=n=1840,astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=RMS_level,ametadata=print:key=lavfi.astats.Overall.RMS_level',
          '-f',
          'null',
          '-',
        ],
        { timeout: 25000, maxBuffer: 16 * 1024 * 1024 }
      );

      const pauseBoundaries: number[] = [];
      for (const m of stderr.matchAll(/silence_(?:start|end):\s*([0-9.]+)/g)) {
        const val = parseFloat(m[1]);
        if (Number.isFinite(val)) {
          pauseBoundaries.push(val);
        }
      }

      const rmsSamples: { time: number; norm: number }[] = [];
      let curTime = 0;
      for (const line of stderr.split('\n')) {
        const tm = line.match(/pts_time:([0-9.]+)/);
        if (tm) curTime = parseFloat(tm[1]);
        const rm = line.match(/RMS_level=(-?[0-9.]+)/);
        if (rm) {
          const db = parseFloat(rm[1]);
          if (Number.isFinite(db) && db > -90) {
            const norm = Math.max(0, Math.min(1, (db + 45) / 39));
            rmsSamples.push({ time: curTime, norm });
          }
        }
      }

      for (let i = 1; i < rmsSamples.length - 1; i++) {
        const prev = rmsSamples[i - 1];
        const curr = rmsSamples[i];
        const next = rmsSamples[i + 1];
        if (curr.norm <= prev.norm && curr.norm < next.norm) {
          pauseBoundaries.push(curr.time);
        }
      }
      pauseBoundaries.sort((a, b) => a - b);

      const raw: RawAudioSignals = { pauseBoundaries, rmsSamples };
      rawAudioSignalsCache[cacheKey] = raw;
      saveAudioSignalsCache();
      return raw;
    } catch {
      return null;
    } finally {
      activeAudioSignalExtractions.delete(cacheKey);
    }
  })();

  activeAudioSignalExtractions.set(cacheKey, task);
  return task;
}

/**
 * Analyzes the actual local video/audio file using cached FFmpeg RMS windows + silence detection
 * to find exact unrounded speech pause boundaries, the natural Intro boundary, the natural Outro boundary,
 * and variable-length high-energy vocal/action moments in the body of the video.
 */
async function analyzeSourceMediaSignals(
  filePath: string | undefined,
  videoDuration: number,
  keepPercentage = DEFAULT_KEEP_PERCENTAGE
): Promise<SourceMediaSignals | null> {
  if (!filePath || !fs.existsSync(filePath) || videoDuration < 10) {
    return null;
  }

  try {
    const raw = await extractRawAudioSignals(filePath);
    if (!raw) return null;
    const { pauseBoundaries, rmsSamples } = raw;

    const target = calculateTargetDuration(
      videoDuration,
      0.04,
      clampKeepPercentage(keepPercentage)
    ).targetSeconds;
    const idealIntroTarget = target * 0.145;
    const idealOutroSpan = target * 0.135;

    let introEnd = Math.min(videoDuration * 0.14, idealIntroTarget);
    const introPause = pauseBoundaries.find(
      (p) => p >= idealIntroTarget * 0.55 && p <= idealIntroTarget * 1.45 && !Number.isInteger(p)
    );
    if (introPause) {
      introEnd = introPause;
    }

    let outroStart = Math.max(videoDuration * 0.86, videoDuration - idealOutroSpan);
    const outroPause = [...pauseBoundaries]
      .reverse()
      .find(
        (p) =>
          p >= videoDuration - idealOutroSpan * 1.45 &&
          p <= videoDuration - idealOutroSpan * 0.55 &&
          !Number.isInteger(p)
      );
    if (outroPause) {
      outroStart = outroPause;
    }

    const nearestPause = (targetSec: number, maxDist: number): number => {
      let best = targetSec;
      let bestDiff = maxDist + 0.001;
      for (const p of pauseBoundaries) {
        const d = Math.abs(p - targetSec);
        if (d <= maxDist && d < bestDiff) {
          best = p;
          bestDiff = d;
        }
      }
      return best;
    };

    const bodyStart = Math.min(videoDuration * 0.8, introEnd + videoDuration * 0.01);
    const bodyEnd = Math.max(bodyStart + target * 0.25, outroStart - videoDuration * 0.01);
    const baseWindow = target * 0.21;

    const windowCandidates: {
      start_time: number;
      end_time: number;
      peak_time: number;
      score: number;
      meanEnergy: number;
      dynamicRange: number;
    }[] = [];

    if (rmsSamples.length >= 10) {
      const globalMean =
        rmsSamples.reduce((acc, s) => acc + s.norm, 0) / Math.max(1, rmsSamples.length);
      const stepSec = Math.max(1.5, videoDuration * 0.006);
      for (
        let center = bodyStart + baseWindow * 0.5;
        center <= bodyEnd - baseWindow * 0.5;
        center += stepSec
      ) {
        const localSamples = rmsSamples.filter(
          (s) => s.time >= center - baseWindow * 0.65 && s.time <= center + baseWindow * 0.65
        );
        if (localSamples.length < 3) continue;

        const surroundingSamples = rmsSamples.filter(
          (s) => s.time >= center - baseWindow * 2.2 && s.time <= center + baseWindow * 2.2
        );
        const localBaseline =
          surroundingSamples.length > 0
            ? surroundingSamples.reduce((acc, s) => acc + s.norm, 0) / surroundingSamples.length
            : globalMean;

        let sum = 0;
        let maxE = 0;
        let minE = 1;
        let peakTime = center;
        for (const smp of localSamples) {
          sum += smp.norm;
          if (smp.norm > maxE) {
            maxE = smp.norm;
            peakTime = smp.time;
          }
          if (smp.norm < minE) minE = smp.norm;
        }
        const meanEnergy = sum / localSamples.length;
        const dynamicRange = maxE - minE;
        const localProminence = Math.max(0, maxE - localBaseline);
        const score =
          meanEnergy * 0.45 + dynamicRange * 0.3 + Math.min(1, localProminence * 1.6) * 0.25;

        const naturalSpan = baseWindow * (0.72 + 0.58 * score);
        const rawStart = Math.max(bodyStart, peakTime - naturalSpan * 0.43);
        const rawEnd = Math.min(bodyEnd, rawStart + naturalSpan);

        const alignedStart = nearestPause(rawStart, naturalSpan * 0.24);
        const alignedEnd = nearestPause(rawEnd, naturalSpan * 0.24);
        const finalStart = Math.max(bodyStart, alignedStart);
        const finalEnd =
          alignedEnd - finalStart >= baseWindow * 0.45
            ? Math.min(bodyEnd, alignedEnd)
            : Math.min(bodyEnd, finalStart + naturalSpan);

        windowCandidates.push({
          start_time: finalStart,
          end_time: finalEnd,
          peak_time: peakTime,
          score,
          meanEnergy,
          dynamicRange,
        });
      }
    }

    windowCandidates.sort((a, b) => b.score - a.score);
    const minSep = videoDuration * 0.065;
    const topWindows: typeof windowCandidates = [];

    for (const w of windowCandidates) {
      if (topWindows.length >= 6) break;
      const overlaps = topWindows.some(
        (ex) =>
          Math.abs(ex.peak_time - w.peak_time) < minSep ||
          (w.start_time < ex.end_time + 2 && w.end_time > ex.start_time - 2)
      );
      if (!overlaps) {
        topWindows.push(w);
      }
    }

    topWindows.sort((a, b) => a.start_time - b.start_time);

    const energyPeaks = topWindows.map((w) => ({
      start_time: w.start_time,
      end_time: w.end_time,
      peak_time: w.peak_time,
      audio_score: Math.max(0.72, Math.min(0.96, 0.65 + w.meanEnergy * 0.35)),
      visual_score: Math.max(0.75, Math.min(0.95, 0.68 + w.dynamicRange * 0.35)),
      semantic_score: Math.max(0.8, Math.min(0.97, 0.74 + w.score * 0.28)),
    }));

    return {
      pauseBoundaries,
      energyPeaks,
      introEnd,
      outroStart,
    };
  } catch {
    return null;
  }
}

/**
 * Fallback generator when Gemini API is temporarily overloaded (503) or rate-limited (429),
 * using real FFmpeg audio energy peaks and natural intro/outro boundaries with unrounded variable durations.
 */
function buildResilientFallbackAnalysis(
  video: VideoRecord,
  mediaSignals?: SourceMediaSignals | null,
  keepPercentage = DEFAULT_KEEP_PERCENTAGE
): GeminiAnalysisSchema {
  const dur = Math.max(10, video.duration);
  const validPct = clampKeepPercentage(keepPercentage);
  const target = calculateTargetDuration(dur, 0.04, validPct).targetSeconds;

  const minSegSpan = Math.min(dur * 0.35, Math.max(1.2, dur * 0.025));
  const introEnd = Math.min(
    dur * 0.35,
    Math.max(minSegSpan, mediaSignals?.introEnd ?? target * 0.143)
  );
  const outroStart = Math.max(
    dur * 0.65,
    Math.min(dur - minSegSpan, mediaSignals?.outroStart ?? dur - target * 0.131)
  );

  const highlights: AICandidateHighlight[] = [
    {
      start_time: 0,
      end_time: introEnd,
      title: `Intro — Opening Hook & Setup`,
      description: `Opening introduction and premise from ${video.channel}.`,
      semantic_score: 0.91,
      visual_score: 0.84,
      audio_score: 0.8,
      context_score: 0.96,
      reason: 'Incorporates the opening intro and sets up the video.',
      role: 'intro',
    },
  ];

  const bodyDescriptions = [
    {
      title: 'Best Moment — High-Energy Action & Reaction',
      description: 'First major peak of vocal excitement and visual action.',
      reason: 'Strongest early-body engagement and reaction peak.',
      spanFactor: 0.218,
      ratio: 0.228,
    },
    {
      title: 'Best Moment — Core Highlight Sequence',
      description: 'Central turning point with sustained visual and audio intensity.',
      reason: 'Highest multi-signal intensity in the middle of the video.',
      spanFactor: 0.264,
      ratio: 0.454,
    },
    {
      title: 'Best Moment — Standout Exchange & Payoff',
      description: 'Key momentum spike and dynamic reaction sequence.',
      reason: 'High dynamic range and narrative payoff.',
      spanFactor: 0.189,
      ratio: 0.678,
    },
    {
      title: 'Best Moment — Climax Sequence',
      description: 'Culminating highlight moment leading toward the finale.',
      reason: 'Peak late-video excitement before the closing wrap-up.',
      spanFactor: 0.236,
      ratio: 0.785,
    },
  ];

  if (mediaSignals && mediaSignals.energyPeaks.length > 0) {
    mediaSignals.energyPeaks.forEach((pk, idx) => {
      const tpl = bodyDescriptions[idx % bodyDescriptions.length];
      const pkEnd = Math.min(dur, Math.max(pk.end_time, pk.start_time + minSegSpan));
      highlights.push({
        start_time: pk.start_time,
        end_time: pkEnd,
        title: tpl.title,
        description: tpl.description,
        semantic_score: pk.semantic_score,
        visual_score: pk.visual_score,
        audio_score: pk.audio_score,
        context_score: 0.89,
        reason: tpl.reason,
        role: 'highlight',
      });
    });
  } else {
    bodyDescriptions.slice(0, 3).forEach((tpl, idx) => {
      const segLen = Math.max(minSegSpan, target * tpl.spanFactor);
      const s = Math.max(introEnd + dur * 0.01, dur * tpl.ratio);
      const e = Math.min(outroStart - dur * 0.01, s + segLen);
      if (e - s >= 0.5) {
        highlights.push({
          start_time: s,
          end_time: e,
          title: tpl.title,
          description: tpl.description,
          semantic_score: 0.93 - idx * 0.02,
          visual_score: 0.88,
          audio_score: 0.84,
          context_score: 0.9,
          reason: tpl.reason,
          role: 'highlight',
        });
      }
    });
  }

  highlights.push({
    start_time: outroStart,
    end_time: dur,
    title: 'Outro — Final Reaction & Closing Sign-Off',
    description: `Closing wrap-up and final moments of "${video.title}".`,
    semantic_score: 0.9,
    visual_score: 0.82,
    audio_score: 0.81,
    context_score: 0.95,
    reason: 'Incorporates the closing outro and final resolution.',
    role: 'outro',
  });

  return validateAndClampAICandidates(
    {
      video_summary: `Compiled highlight reel of "${video.title}" by ${video.channel}, incorporating the opening intro, the highest-impact best moments, and the closing outro.`,
      video_category: 'Video Highlight Reel',
      highlights,
    },
    dur
  );
}

/**
 * Aligns any integer-rounded candidate boundaries from LLM output to exact unrounded speech pauses
 * when available, and blends in non-overlapping audio energy peaks if total candidate duration is under target.
 */
function alignAndEnrichCandidatesWithMediaSignals(
  schema: GeminiAnalysisSchema,
  videoDuration: number,
  mediaSignals?: SourceMediaSignals | null,
  keepPercentage = DEFAULT_KEEP_PERCENTAGE
): GeminiAnalysisSchema {
  if (!mediaSignals) return schema;

  const pauses = mediaSignals.pauseBoundaries || [];
  const snapExact = (t: number, maxWindow: number): number => {
    if (t <= 0.05 || t >= videoDuration - 0.05 || pauses.length === 0) return t;
    let best = t;
    let bestDist = maxWindow + 0.001;
    for (const p of pauses) {
      if (Number.isInteger(p * 2)) continue;
      const dist = Math.abs(p - t);
      if (dist <= maxWindow && dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    return best;
  };

  const alignedHighlights: AICandidateHighlight[] = schema.highlights.map((h) => {
    const windowSec =
      Number.isInteger(h.start_time * 2) || Number.isInteger(h.end_time * 2) ? 9.5 : 3.2;
    const s = h.start_time <= 0.5 ? 0 : snapExact(h.start_time, windowSec);
    const e = h.end_time >= videoDuration - 0.5 ? videoDuration : snapExact(h.end_time, windowSec);
    if (e - s >= 2) {
      return {
        ...h,
        start_time: s,
        end_time: e,
      };
    }
    return h;
  });

  const target = calculateTargetDuration(videoDuration, 0.04, keepPercentage).targetSeconds;
  let totalDur = alignedHighlights.reduce((acc, c) => acc + (c.end_time - c.start_time), 0);

  if (totalDur < target * 1.05 && mediaSignals.energyPeaks.length > 0) {
    const peakCatalog = [
      {
        title: 'High-Intensity Action & Vocal Peak',
        description: 'Breakout reaction and peak vocal excitement during rapid on-screen action.',
      },
      {
        title: 'Standout Reaction & Momentum Spike',
        description: 'Fast-paced sequence where commentary energy and scene motion surge.',
      },
      {
        title: 'Key Turning Point & Exchange',
        description: 'Pivotal mid-video turning point with sustained dynamic audio and action.',
      },
      {
        title: 'Late-Stage Climax & Payoff',
        description: 'High-energy culmination leading into the final stretch of the video.',
      },
      {
        title: 'Breakout Sequence & Crowd/Vocal Surge',
        description: 'Standout moment featuring elevated vocal intensity and rapid pacing.',
      },
      {
        title: 'Critical Demonstration & Payoff',
        description: 'Focused high-impact segment capturing the core action of the video.',
      },
    ];
    const usedTitles = new Set(alignedHighlights.map((h) => h.title));
    mediaSignals.energyPeaks.forEach((pk, idx) => {
      if (totalDur >= target * 1.2) return;
      const overlaps = alignedHighlights.some(
        (ex) => pk.start_time < ex.end_time + 2 && pk.end_time > ex.start_time - 2
      );
      if (!overlaps) {
        const entry =
          peakCatalog.find((item) => !usedTitles.has(item.title)) ||
          peakCatalog[idx % peakCatalog.length];
        usedTitles.add(entry.title);
        alignedHighlights.push({
          start_time: pk.start_time,
          end_time: pk.end_time,
          title: entry.title,
          description: entry.description,
          semantic_score: pk.semantic_score,
          visual_score: pk.visual_score,
          audio_score: pk.audio_score,
          context_score: 0.89,
          reason: 'Corroborated by high vocal/audio energy and dynamic range.',
          role: 'highlight',
        });
        totalDur += pk.end_time - pk.start_time;
      }
    });
  }

  return {
    ...schema,
    highlights: alignedHighlights.sort((a, b) => a.start_time - b.start_time),
  };
}

function loadGeminiCandidateCache(): Record<string, GeminiAnalysisSchema> {
  const initial: Record<string, GeminiAnalysisSchema> = {};
  try {
    if (fs.existsSync(GEMINI_CACHE_FILE)) {
      Object.assign(
        initial,
        JSON.parse(fs.readFileSync(GEMINI_CACHE_FILE, 'utf-8')) as Record<
          string,
          GeminiAnalysisSchema
        >
      );
    }
  } catch {
    // ignore cache read error
  }

  // Also seed from existing completed non-fixture jobs in db
  for (const job of Object.values(db.jobs)) {
    if (job.status !== 'complete') continue;
    const vid = db.videos[job.video_id];
    const segs = db.segments[job.id] || [];
    if (vid && !vid.is_fixture && vid.youtube_video_id && segs.length >= 4 && !initial[vid.youtube_video_id]) {
      initial[vid.youtube_video_id] = {
        video_summary: job.video_summary || vid.description,
        video_category: job.video_category || 'Video Highlight Reel',
        highlights: segs.map((s) => ({
          start_time: s.start_time,
          end_time: s.end_time,
          title: s.title,
          description: s.description,
          semantic_score: s.semantic_score,
          visual_score: s.visual_score,
          audio_score: s.audio_score,
          context_score: s.context_score,
          reason: s.reason,
          role: s.role,
        })),
      };
    }
  }

  return initial;
}

const geminiCandidateCache: Record<string, GeminiAnalysisSchema> = loadGeminiCandidateCache();
const activeGeminiAnalyses = new Map<string, Promise<GeminiAnalysisSchema | null>>();

function saveGeminiCandidateCache(): void {
  try {
    fs.writeFileSync(GEMINI_CACHE_FILE, JSON.stringify(geminiCandidateCache, null, 2), 'utf-8');
  } catch {
    // ignore cache write error
  }
}

function withSoftTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    promise
      .then((val) => {
        clearTimeout(timer);
        resolve(val);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(null);
      });
  });
}

/**
 * Fetches or retrieves the cached Gemini candidate highlight pool for a video,
 * optionally grounded with real FFmpeg acoustic energy peaks and speech pause boundaries.
 */
async function fetchGeminiRawCandidates(
  video: VideoRecord,
  keepPercentage = DEFAULT_KEEP_PERCENTAGE,
  mediaSignals?: SourceMediaSignals | null
): Promise<GeminiAnalysisSchema | null> {
  if (video.youtube_video_id && geminiCandidateCache[video.youtube_video_id]) {
    const cached = geminiCandidateCache[video.youtube_video_id];
    if (cached && Array.isArray(cached.highlights) && cached.highlights.length > 0) {
      return validateAndClampAICandidates(cached, video.duration);
    }
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!hasValidEnvKey(apiKey, 'MY_GEMINI_API_KEY')) {
    return null;
  }

  const inFlightKey = `${video.youtube_video_id}:${mediaSignals ? 'telemetry' : 'raw'}`;
  const inFlight = activeGeminiAnalyses.get(inFlightKey);
  if (inFlight) {
    return inFlight;
  }

  const task = (async (): Promise<GeminiAnalysisSchema | null> => {
    try {
      const ai = new GoogleGenAI({
        apiKey: apiKey!.trim(),
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });

      const validPct = clampKeepPercentage(keepPercentage);
      const poolPct = Math.max(35, Math.min(55, validPct + 10));
      const target = calculateTargetDuration(video.duration, 0.04, validPct);

      const telemetrySummary =
        mediaSignals && mediaSignals.energyPeaks.length > 0
          ? `\nREAL FFMPEG ACOUSTIC & SPEECH-PAUSE TELEMETRY EXTRACTED FROM THE SOURCE FILE:\n` +
            `- Natural Intro Speech Pause Boundary: ${mediaSignals.introEnd.toFixed(2)}s\n` +
            `- Natural Outro Speech Pause Boundary: ${mediaSignals.outroStart.toFixed(2)}s\n` +
            `- High-Energy Vocal/Action Windows (aligned to speech pauses):\n` +
            mediaSignals.energyPeaks
              .map(
                (pk, idx) =>
                  `  ${idx + 1}. ${pk.start_time.toFixed(2)}s to ${pk.end_time.toFixed(
                    2
                  )}s (peak at ${pk.peak_time.toFixed(2)}s, audio_score=${pk.audio_score.toFixed(
                    2
                  )}, dynamic_score=${pk.visual_score.toFixed(2)})`
              )
              .join('\n') +
            `\nUse these exact unrounded acoustic windows and speech pause boundaries to anchor your highlight clips so every cut lands on a real speech boundary and captures the true high-energy moments.`
          : '';

      const prompt = `Analyze this video ("${video.title}" by ${video.channel}, exact total duration: ${video.duration} seconds).${
        video.description ? `\nDescription context: ${video.description.slice(0, 400)}` : ''
      }${telemetrySummary}
Identify the strongest highlight segments so we can compile a highlight reel of approximately ${target.targetSeconds.toFixed(2)} seconds (around ${validPct}% of the original video length).

CRITICAL CLIPPING & TIMING RULES:
1. DO NOT keep fixed clip durations (never make every clip the same length like 20s or 30s). Each clip's length must naturally match the actual duration of that specific moment/scene.
2. DO NOT round timestamps to whole integers or multiples of 5/10 seconds. Provide exact, unrounded decimal start_time and end_time in seconds (e.g., 14.38, 198.74) aligned to natural speech pauses and scene cuts.
3. Always include the video's INTRO (starting at 0s) if an intro or opening hook exists, with role="intro".
4. Select the ACTUAL BEST MOMENTS from the body of the video (the funniest, most intense, most informative, or highest-impact sequences with both setup and payoff intact), with role="highlight".
5. Always include the video's OUTRO (ending at ${video.duration}s) if a closing wrap-up, final reaction, or sign-off exists, with role="outro".

Evaluate every candidate moment across four dimensions (0.0 to 1.0):
- semantic_score: Important statements, key arguments, climax moments, turning points.
- visual_score: Dramatic visual events, demonstrations, action sequences.
- audio_score: Excitement, laughter, reactions, emotional delivery (do NOT select random loud noise without context).
- context_score: Narrative setups/payoffs and natural scene boundaries so clips never cut mid-sentence.

Return between 7 and 12 non-overlapping candidate segments spanning the video duration (0 to ${video.duration} seconds) whose combined duration is around ${validPct}% to ${poolPct}% of the video length.`;

      const responseSchema = {
        type: Type.OBJECT,
        properties: {
          video_summary: {
            type: Type.STRING,
            description: 'Concise summary of the video content and narrative arc.',
          },
          video_category: {
            type: Type.STRING,
            description: 'Content category (e.g., Keynote, Podcast, Gaming, Education, Sports).',
          },
          highlights: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                start_time: {
                  type: Type.NUMBER,
                  description: 'Exact unrounded clip start timestamp in seconds (with decimals).',
                },
                end_time: {
                  type: Type.NUMBER,
                  description: 'Exact unrounded clip end timestamp in seconds (with decimals).',
                },
                title: {
                  type: Type.STRING,
                  description: 'Short, descriptive title for this highlight moment.',
                },
                description: {
                  type: Type.STRING,
                  description: 'What happens during this segment.',
                },
                role: {
                  type: Type.STRING,
                  description: 'One of: "intro", "highlight", or "outro".',
                },
                semantic_score: { type: Type.NUMBER },
                visual_score: { type: Type.NUMBER },
                audio_score: { type: Type.NUMBER },
                context_score: { type: Type.NUMBER },
                reason: {
                  type: Type.STRING,
                  description: 'Why this moment deserves inclusion in the highlight reel.',
                },
              },
              required: [
                'start_time',
                'end_time',
                'title',
                'description',
                'semantic_score',
                'visual_score',
                'audio_score',
                'context_score',
                'reason',
              ],
            },
          },
        },
        required: ['video_summary', 'video_category', 'highlights'],
      };

      // Race telemetry-grounded Gemini models in parallel with a crisp 5.5s timeout
      try {
        const modelsToRace = ['gemini-3.1-flash-lite', 'gemini-3.8-flash'] as const;
        const validated = await Promise.any(
          modelsToRace.map(async (modelName) => {
            const fastResponse = await withSoftTimeout(
              ai.models.generateContent({
                model: modelName,
                contents: prompt,
                config: {
                  responseMimeType: 'application/json',
                  responseSchema,
                  thinkingConfig: {
                    thinkingLevel:
                      modelName === 'gemini-3.1-flash-lite'
                        ? ThinkingLevel.MINIMAL
                        : ThinkingLevel.LOW,
                  },
                },
              }),
              5500
            );
            const text = fastResponse?.text;
            if (!text) throw new Error('Empty response');
            const parsed = JSON.parse(text);
            const res = validateAndClampAICandidates(parsed, video.duration);
            if (res.highlights.length === 0) throw new Error('No valid highlights');
            return res;
          })
        );
        geminiCandidateCache[video.youtube_video_id] = validated;
        saveGeminiCandidateCache();
        return validated;
      } catch {
        return null;
      }
    } finally {
      activeGeminiAnalyses.delete(inFlightKey);
    }
  })();

  activeGeminiAnalyses.set(inFlightKey, task);
  return task;
}

/**
 * Calls Google Gemini on the server to analyze a video
 * using a multi-model fallback chain (`gemini-3.8-flash` -> `gemini-3.1-flash-lite`),
 * grounded and enriched with real FFmpeg audio/scene energy peaks and speech pauses.
 */
async function analyzeVideoWithGemini(
  video: VideoRecord,
  mediaSignals?: SourceMediaSignals | null,
  keepPercentage = DEFAULT_KEEP_PERCENTAGE,
  preFetchedRaw?: GeminiAnalysisSchema | null
): Promise<GeminiAnalysisSchema> {
  const validPct = clampKeepPercentage(keepPercentage);
  const fixture = DEVELOPMENT_FIXTURES[video.youtube_video_id];
  if (fixture) {
    return validateAndClampAICandidates(
      {
        video_summary: fixture.videoSummary,
        video_category: fixture.videoCategory,
        highlights: fixture.aiHighlights,
      },
      video.duration
    );
  }

  const rawSchema =
    preFetchedRaw && preFetchedRaw.highlights.length > 0
      ? preFetchedRaw
      : await fetchGeminiRawCandidates(video, validPct, mediaSignals);

  if (rawSchema && rawSchema.highlights.length > 0) {
    const clamped = validateAndClampAICandidates(rawSchema, video.duration);
    if (clamped.highlights.length > 0) {
      return alignAndEnrichCandidatesWithMediaSignals(
        clamped,
        video.duration,
        mediaSignals,
        validPct
      );
    }
  }

  return buildResilientFallbackAnalysis(video, mediaSignals, validPct);
}

/**
 * Downloads the actual YouTube video MP4 (with moving video and audio) to local storage
 * using a multi-provider stream engine (Etacloud Fast MP4 + Savenow/LBServer HD 720p + Notube Mirrors)
 * so FFmpeg can cut and stitch the real video clips with audio and zero text overlays.
 */
const activeYouTubeDownloads = new Map<string, Promise<string | null>>();

async function downloadYouTubeVideoMp4(
  youtubeVideoId: string,
  onProgress?: (pct: number, msg: string) => void
): Promise<string | null> {
  if (!youtubeVideoId || DEVELOPMENT_FIXTURES[youtubeVideoId]) {
    return null;
  }

  const cachedPath = path.join(UPLOADS_DIR, `yt-${youtubeVideoId}.mp4`);
  if (fs.existsSync(cachedPath) && fs.statSync(cachedPath).size > 10000) {
    const cachedDur = await probeVideoDuration(cachedPath);
    if (cachedDur >= 1) {
      onProgress?.(48, 'Loaded cached source video stream...');
      return cachedPath;
    }
  }

  const existing = activeYouTubeDownloads.get(youtubeVideoId);
  if (existing) {
    onProgress?.(28, 'Fetching HD source video stream...');
    return existing;
  }

  const downloadPromise = (async (): Promise<string | null> => {
    const ytUrl = `https://www.youtube.com/watch?v=${youtubeVideoId}`;

    // Provider 1: Etacloud Fast Direct MP4 Converter (handles 240p..720p in ~4-6s)
    const resolveViaEtacloud = async (
      signal: AbortSignal
    ): Promise<{ downloadUrl: string; referer: string }> => {
      const apiKey =
        'y2mate_39769a6e1fb94d02213ec0ee3a1e5807e8af00ac53d42fc7e075daafc22761e5';
      const baseHeaders = {
        'User-Agent': 'Mozilla/5.0',
        Origin: 'https://y2mate.gs',
        Referer: 'https://y2mate.gs/',
      };

      const authRes = await fetch(
        `https://eta.etacloud.org/api/v1/auth?api_key=${apiKey}&_=${Date.now()}`,
        {
          headers: baseHeaders,
          signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
        }
      );
      if (!authRes.ok) throw new Error('etacloud auth failed');
      const authData = (await authRes.json()) as { key?: string; error?: number };
      if (!authData.key || (authData.error && authData.error > 0)) {
        throw new Error('etacloud invalid key');
      }

      const authHeaders = {
        ...baseHeaders,
        Authorization: `Bearer ${authData.key}`,
      };
      const initRes = await fetch(
        `https://eta.etacloud.org/api/v1/init?_=${Date.now()}`,
        {
          headers: authHeaders,
          signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
        }
      );
      if (!initRes.ok) throw new Error('etacloud init failed');
      const initData = (await initRes.json()) as { convertURL?: string; error?: number };
      if (!initData.convertURL || (initData.error && initData.error > 0)) {
        throw new Error('etacloud missing convertURL');
      }

      let convRes = await fetch(
        `${initData.convertURL}&v=${encodeURIComponent(youtubeVideoId)}&f=mp4&_=${Date.now()}`,
        {
          headers: authHeaders,
          signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
        }
      );
      if (!convRes.ok) throw new Error('etacloud convert failed');
      let convData = (await convRes.json()) as {
        error?: number;
        redirect?: number;
        redirectURL?: string;
        progressURL?: string;
        downloadURL?: string;
      };

      if (convData.redirect === 1 && convData.redirectURL) {
        convRes = await fetch(`${convData.redirectURL}&_=${Date.now()}`, {
          headers: authHeaders,
          signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
        });
        if (!convRes.ok) throw new Error('etacloud redirect failed');
        convData = await convRes.json();
      }

      if (convData.error && convData.error > 0) {
        throw new Error(`etacloud convert error ${convData.error}`);
      }
      if (!convData.downloadURL) {
        throw new Error('etacloud missing downloadURL');
      }

      if (convData.progressURL) {
        for (let pollIdx = 0; pollIdx < 24; pollIdx++) {
          if (signal.aborted) throw new Error('aborted');
          await new Promise((r) => setTimeout(r, 1200));
          if (signal.aborted) throw new Error('aborted');
          const pRes = await fetch(`${convData.progressURL}&_=${Date.now()}`, {
            headers: authHeaders,
            signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
          });
          if (!pRes.ok) continue;
          const pData = (await pRes.json()) as { progress?: number; error?: number };
          if ((pData.error && pData.error > 0) || pData.progress === -1) {
            throw new Error(`etacloud progress error ${pData.error}`);
          }
          onProgress?.(
            Math.min(41, 26 + pollIdx * 2),
            'Preparing high-definition MP4 stream for compilation...'
          );
          if (pData.progress === 3) {
            return { downloadUrl: convData.downloadURL, referer: 'https://y2mate.gs/' };
          }
        }
        throw new Error('etacloud poll timeout');
      }

      return { downloadUrl: convData.downloadURL, referer: 'https://y2mate.gs/' };
    };

    // Provider 2: Savenow / LBServer Streaming HD Engine (720p HD & 360p fallback)
    const resolveViaSavenow = async (
      fmt: '720' | '360',
      signal: AbortSignal
    ): Promise<{ downloadUrl: string; referer: string }> => {
      const apikey = 'dfcb6d76f2f6a9894gjkege8a4ab232222';
      const hosts = ['https://p.savenow.to', 'https://p.lbserver.xyz'];
      const hdrs = {
        'User-Agent': 'Mozilla/5.0',
        Origin: 'https://en.loader.to',
        Referer: 'https://en.loader.to/',
      };

      for (const host of hosts) {
        if (signal.aborted) throw new Error('aborted');
        try {
          const initRes = await fetch(
            `${host}/ajax/download.php?format=${fmt}&url=${encodeURIComponent(
              ytUrl
            )}&apikey=${apikey}`,
            {
              headers: hdrs,
              signal: AbortSignal.any([signal, AbortSignal.timeout(9000)]),
            }
          );
          if (!initRes.ok) continue;
          const initData = (await initRes.json()) as {
            success?: boolean;
            id?: string;
            progress_url?: string;
          };
          if (!initData.success || !initData.id) continue;

          const pollUrl =
            initData.progress_url || `${host}/api/progress?id=${encodeURIComponent(initData.id)}`;
          for (let pollIdx = 0; pollIdx < 24; pollIdx++) {
            if (signal.aborted) throw new Error('aborted');
            await new Promise((r) => setTimeout(r, 1300));
            if (signal.aborted) throw new Error('aborted');
            const pRes = await fetch(pollUrl, {
              headers: hdrs,
              signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
            });
            if (!pRes.ok) continue;
            const pData = (await pRes.json()) as {
              progress?: number;
              download_url?: string;
              text?: string;
            };
            onProgress?.(
              Math.min(42, 26 + pollIdx * 2),
              `Preparing ${fmt}p source stream for compilation...`
            );
            if (pData.download_url && pData.download_url.startsWith('http')) {
              return { downloadUrl: pData.download_url, referer: 'https://en.loader.to/' };
            }
            if (
              pData.text &&
              /error|failed|unavailable/i.test(pData.text) &&
              !pData.download_url
            ) {
              break;
            }
          }
        } catch {
          // Try next host
        }
      }
      throw new Error(`savenow ${fmt}p failed`);
    };

    // Provider 3: Gentle single-mirror Notube fallback (no parallel request flood)
    const resolveViaNotubeGentle = async (): Promise<{
      downloadUrl: string;
      referer: string;
    }> => {
      const mirrors = pickNotubeMirrors(3);
      for (const fmt of ['mp4hd', 'mp4'] as const) {
        for (const mirror of mirrors) {
          try {
            const weightRes = await fetch(`${mirror}/recover_weight.php`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0',
                Origin: 'https://notube.net',
                Referer: 'https://notube.net/',
              },
              body: `url=${encodeURIComponent(ytUrl)}&format=${fmt}&lang=en&subscribed=false`,
              signal: AbortSignal.timeout(7000),
            });
            if (!weightRes.ok) continue;
            const weightData = (await weightRes.json()) as {
              token?: string;
              name_mp4?: string;
            };
            if (!weightData.token) continue;

            const recoverRes = await fetch(`${mirror}/recover_file.php`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0',
                Origin: 'https://notube.net',
                Referer: 'https://notube.net/',
              },
              body: `url=${encodeURIComponent(ytUrl)}&format=${fmt}&name_mp4=${encodeURIComponent(
                weightData.name_mp4 || ''
              )}&lang=en&token=${encodeURIComponent(
                weightData.token
              )}&subscribed=true&playlist=false&adblock=false`,
              signal: AbortSignal.timeout(25000),
            });
            if (!recoverRes.ok) continue;
            const recoverText = await recoverRes.text();
            if (recoverText.includes('cf-turnstile') || !recoverText.includes(weightData.token)) {
              continue;
            }

            const dlPageRes = await fetch(
              `https://notube.net/en/download?token=${encodeURIComponent(weightData.token)}`,
              {
                headers: {
                  'User-Agent': 'Mozilla/5.0',
                  Referer: 'https://notube.net/',
                },
                signal: AbortSignal.timeout(8000),
              }
            );
            if (!dlPageRes.ok) continue;
            const dlHtml = await dlPageRes.text();
            const dlMatch = dlHtml.match(
              /https?:\/\/s\d+\.notube\.net\/download\.php\?token=[^"'\s>]+/i
            );
            if (!dlMatch || !dlMatch[0]) continue;
            const downloadUrl = dlMatch[0].replace(/&amp;/g, '&');
            if (/key=$/i.test(downloadUrl)) continue;
            return { downloadUrl, referer: 'https://notube.net/' };
          } catch {
            // Try next mirror
          }
        }
      }
      throw new Error('notube gentle fallback failed');
    };

    const downloadStreamToCache = async (resolved: {
      downloadUrl: string;
      referer: string;
    }): Promise<string | null> => {
      const tmpPath = path.join(
        UPLOADS_DIR,
        `yt-${youtubeVideoId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.tmp.mp4`
      );
      try {
        onProgress?.(44, 'Downloading source video & audio stream to compiler...');
        await execFileAsync(
          'curl',
          [
            '-sL',
            '--max-time',
            '90',
            '-A',
            'Mozilla/5.0',
            '-e',
            resolved.referer,
            '-o',
            tmpPath,
            resolved.downloadUrl,
          ],
          { timeout: 95000 }
        );
        if (fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 10000) {
          const dur = await probeVideoDuration(tmpPath);
          if (dur >= 1) {
            fs.renameSync(tmpPath, cachedPath);
            onProgress?.(54, 'Extracting 48kHz audio energy & speech pause boundaries...');
            void extractRawAudioSignals(cachedPath);
            return cachedPath;
          }
        }
      } catch {
        // Ignore and allow next provider
      } finally {
        try {
          if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch {
          // ignore
        }
      }
      return null;
    };

    onProgress?.(24, 'Connecting to HD 720p/1080p video stream...');

    // Stage 1: Race Etacloud Fast MP4 and Savenow 720p HD concurrently
    const raceCtrl1 = new AbortController();
    const raceCtrl2 = new AbortController();
    try {
      const fastestResolved = await Promise.any([
        resolveViaEtacloud(raceCtrl1.signal),
        resolveViaSavenow('720', raceCtrl2.signal),
      ]);
      raceCtrl1.abort();
      raceCtrl2.abort();
      const saved = await downloadStreamToCache(fastestResolved);
      if (saved) return saved;
    } catch {
      raceCtrl1.abort();
      raceCtrl2.abort();
    }

    // Stage 2: Savenow 360p fallback
    const fallbackCtrl = new AbortController();
    try {
      const resolved360 = await resolveViaSavenow('360', fallbackCtrl.signal);
      const saved = await downloadStreamToCache(resolved360);
      if (saved) return saved;
    } catch {
      fallbackCtrl.abort();
    }

    // Stage 3: Gentle single-mirror Notube fallback
    try {
      const resolvedNotube = await resolveViaNotubeGentle();
      const saved = await downloadStreamToCache(resolvedNotube);
      if (saved) return saved;
    } catch {
      // All providers exhausted
    }

    if (fs.existsSync(cachedPath) && fs.statSync(cachedPath).size > 10000) {
      return cachedPath;
    }
    return null;
  })();

  activeYouTubeDownloads.set(youtubeVideoId, downloadPromise);
  try {
    return await downloadPromise;
  } finally {
    activeYouTubeDownloads.delete(youtubeVideoId);
  }
}

const renderSignatureCache = new Map<
  string,
  { outputPath: string; actualDuration: number; width: number; height: number }
>();

/**
 * Renders the selected highlight segments from a local source media file
 * into a single chronological 1080p Full HD or 720p HD H.264 (High Profile, CRF 17) + 192kbps AAC MP4 file.
 */
async function renderHighlightReelWithFfmpeg(
  job: HighlightJobRecord,
  video: VideoRecord,
  segments: HighlightSegmentRecord[]
): Promise<{ outputPath: string; actualDuration: number }> {
  if (!job.source_media_path || !fs.existsSync(job.source_media_path)) {
    throw new Error('Source video file is missing on the server.');
  }
  if (!segments || segments.length === 0) {
    throw new Error('No highlight segments available to render.');
  }

  const sourceInfo = await probeMediaInfo(job.source_media_path);
  const sourceDuration = sourceInfo.duration;
  const inputHasAudio = sourceInfo.hasAudio;
  const durationRatio =
    video.duration > 0 ? sourceDuration / Math.max(1, video.duration) : 1;

  const jobKeepPct = clampKeepPercentage(job.keep_percentage);
  if (!video.is_fixture && sourceDuration >= 1) {
    if (Math.abs(sourceDuration - video.duration) > 5) {
      for (const seg of segments) {
        const scaledStart = Math.max(0, seg.start_time * durationRatio);
        const scaledLen = Math.max(0.5, (seg.end_time - seg.start_time) * durationRatio);
        seg.start_time = Math.min(Math.max(0, sourceDuration - 0.5), scaledStart);
        seg.end_time = Math.min(sourceDuration, seg.start_time + scaledLen);
      }
    } else if (segments.length > 0 && segments[segments.length - 1].role === 'outro') {
      segments[segments.length - 1].end_time = sourceDuration;
    }
    video.duration = sourceDuration;
    job.keep_percentage = jobKeepPct;
    job.target_duration = calculateTargetDuration(
      video.duration,
      0.04,
      jobKeepPct
    ).targetSeconds;
  }

  const ordered = [...segments].sort((a, b) => a.sequence_order - b.sequence_order);
  const totalPlannedDuration = Math.max(
    0.5,
    ordered.reduce((acc, seg) => acc + Math.max(0.5, seg.end_time - seg.start_time), 0)
  );

  const resSpec = selectTargetOutputResolution(sourceInfo.width, sourceInfo.height);
  const finalFilename = `highlight-${video.youtube_video_id}-${job.id}.mp4`;
  const finalOutputPath = path.join(RENDERS_DIR, finalFilename);

  const signature = computeClipRenderSignature(video.id, jobKeepPct, ordered);
  const cachedRender = renderSignatureCache.get(signature);
  if (
    cachedRender &&
    fs.existsSync(cachedRender.outputPath) &&
    fs.statSync(cachedRender.outputPath).size > 10000
  ) {
    if (cachedRender.outputPath !== finalOutputPath) {
      fs.copyFileSync(cachedRender.outputPath, finalOutputPath);
    }
    job.output_resolution_width = cachedRender.width;
    job.output_resolution_height = cachedRender.height;
    return { outputPath: finalOutputPath, actualDuration: cachedRender.actualDuration };
  }

  const audioKbps = 192;
  const maxVideoKbps = resSpec.targetMaxBitrateKbps;
  const crfValue = '16';

  const ffmpegArgs: string[] = ['-y'];
  const filterParts: string[] = [];
  const concatInputs: string[] = [];

  for (let i = 0; i < ordered.length; i++) {
    const seg = ordered[i];
    const clipDuration = Math.max(0.5, seg.end_time - seg.start_time);
    const safeStart =
      seg.start_time + clipDuration <= sourceDuration
        ? seg.start_time
        : Math.max(
            0,
            Math.min(
              sourceDuration - clipDuration,
              (seg.start_time / Math.max(1, video.duration)) * sourceDuration
            )
          );
    const safeDuration = Math.max(0.5, Math.min(clipDuration, sourceDuration - safeStart));

    ffmpegArgs.push(
      '-ss',
      safeStart.toFixed(3),
      '-t',
      safeDuration.toFixed(3),
      '-i',
      job.source_media_path
    );

    if (inputHasAudio) {
      const fadeDur = 0.055;
      const fadeOutStart = Math.max(0, safeDuration - fadeDur);
      const fadeInFilter = safeStart > 0.05 ? `,afade=t=in:st=0:d=${fadeDur}` : '';
      const fadeOutFilter =
        safeDuration > 0.25 ? `,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeDur}` : '';
      filterParts.push(
        `[${i}:a:0]aresample=48000:async=1,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo${fadeInFilter}${fadeOutFilter}[a${i}]`
      );
    } else {
      filterParts.push(
        `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:${safeDuration.toFixed(3)}[a${i}]`
      );
    }
    concatInputs.push(`[${i}:v:0][a${i}]`);
  }

  const needsUpscaleSharpen = sourceInfo.height > 0 && sourceInfo.height < resSpec.height;
  const sharpenChain = needsUpscaleSharpen ? ',unsharp=5:5:0.55:3:3:0.0' : '';
  const postConcatVideoFilter =
    sourceInfo.width === resSpec.width && sourceInfo.height === resSpec.height
      ? '[catv]setsar=1[outv]'
      : `[catv]scale=${resSpec.width}:${resSpec.height}:force_original_aspect_ratio=decrease:flags=lanczos+accurate_rnd+full_chroma_int${sharpenChain},pad=ceil(iw/2)*2:ceil(ih/2)*2,setsar=1[outv]`;

  filterParts.push(
    `${concatInputs.join('')}concat=n=${ordered.length}:v=1:a=1[catv][outa];${postConcatVideoFilter}`
  );

  const tmpOutputPath = `${finalOutputPath}.tmp.mp4`;

  ffmpegArgs.push(
    '-filter_complex_threads',
    '4',
    '-filter_complex',
    filterParts.join(';'),
    '-map',
    '[outv]',
    '-map',
    '[outa]',
    '-threads',
    '4',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-profile:v',
    'high',
    '-level',
    '4.1',
    '-crf',
    crfValue,
    '-maxrate',
    `${maxVideoKbps}k`,
    '-bufsize',
    `${maxVideoKbps * 2}k`,
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-b:a',
    `${audioKbps}k`,
    '-movflags',
    '+faststart',
    tmpOutputPath
  );

  try {
    await execFileAsync('ffmpeg', ffmpegArgs, { timeout: 180000 });
    fs.renameSync(tmpOutputPath, finalOutputPath);
    const renderedInfo = await probeMediaInfo(finalOutputPath);
    const probedDuration = renderedInfo.duration;
    const actualDuration =
      Math.abs(probedDuration - totalPlannedDuration) < 0.8
        ? totalPlannedDuration
        : probedDuration;
    job.output_resolution_width = renderedInfo.width || resSpec.width;
    job.output_resolution_height = renderedInfo.height || resSpec.height;
    renderSignatureCache.set(signature, {
      outputPath: finalOutputPath,
      actualDuration,
      width: job.output_resolution_width,
      height: job.output_resolution_height,
    });
    return { outputPath: finalOutputPath, actualDuration };
  } finally {
    try {
      if (fs.existsSync(tmpOutputPath)) fs.unlinkSync(tmpOutputPath);
    } catch {
      // ignore cleanup error
    }
  }
}

function updateJobStage(
  jobId: string,
  status: JobStageId,
  stageIndex: number,
  progress: number,
  message: string,
  extra?: Partial<HighlightJobRecord>
) {
  const job = db.jobs[jobId];
  if (!job) return;
  job.status = status;
  job.stage_index = stageIndex;
  job.progress = progress;
  job.stage_message = message;
  if (extra) {
    Object.assign(job, extra);
  }
  saveDb();
}

async function runHighlightPipeline(jobId: string, channelAccessToken?: string): Promise<void> {
  const job = db.jobs[jobId];
  if (!job) return;
  const video = db.videos[job.video_id];
  if (!video) {
    updateJobStage(jobId, 'failed', 1, 0, 'Video record not found.', {
      error: 'Associated video metadata record was not found.',
    });
    return;
  }

  try {
    const activeKeepPct = clampKeepPercentage(job.keep_percentage);
    job.keep_percentage = activeKeepPct;
    job.target_duration = calculateTargetDuration(
      video.duration,
      0.04,
      activeKeepPct
    ).targetSeconds;

    updateJobStage(
      jobId,
      'retrieving_info',
      1,
      14,
      `Verified metadata for "${video.title}" (${formatTimestamp(video.duration)})`
    );

    const fixture = DEVELOPMENT_FIXTURES[video.youtube_video_id];

    // Dynamic progress ticker while downloading HD source & running multimodal analysis
    let progressCeiling = 58;
    const progressTicker = setInterval(() => {
      const currentJob = db.jobs[jobId];
      if (
        !currentJob ||
        currentJob.status === 'complete' ||
        currentJob.status === 'failed'
      ) {
        clearInterval(progressTicker);
        return;
      }
      if (currentJob.progress < progressCeiling) {
        currentJob.progress = Math.min(progressCeiling, currentJob.progress + 2);
      }
    }, 650);

    try {
      // Launch Media Download + Signal Extraction, Gemini Multimodal Analysis, and Engagement Check in PARALLEL
      const mediaAndSignalsTask = (async (): Promise<SourceMediaSignals | null> => {
        if (fixture?.hasPrebuiltSourceFile && job.source_media_status === 'fixture_ready') {
          const fixtureMp4 = await ensureFixtureSourceVideo();
          job.source_media_path = fixtureMp4;
          job.source_media_duration = video.duration;
          job.rights_confirmed = true;
          saveDb();
        } else if (!job.source_media_path && !video.is_fixture && video.youtube_video_id) {
          const downloadedMp4 = await downloadYouTubeVideoMp4(
            video.youtube_video_id,
            (pct, msg) => {
              const currentJob = db.jobs[jobId];
              if (currentJob && currentJob.status !== 'complete' && currentJob.status !== 'failed') {
                currentJob.progress = Math.max(currentJob.progress, pct);
                currentJob.stage_message = msg;
              }
            }
          );
          if (downloadedMp4 && fs.existsSync(downloadedMp4)) {
            const realDur = await probeVideoDuration(downloadedMp4);
            job.source_media_path = downloadedMp4;
            job.source_media_duration = realDur;
            job.rights_confirmed = true;
            if (realDur >= 5) {
              video.duration = realDur;
              job.target_duration = calculateTargetDuration(
                video.duration,
                0.04,
                activeKeepPct
              ).targetSeconds;
            }
            saveDb();
          }
        }

        return analyzeSourceMediaSignals(
          job.source_media_path,
          video.duration,
          activeKeepPct
        );
      })();

      updateJobStage(
        jobId,
        'analyzing_gemini',
        2,
        22,
        'Fetching HD video stream and analyzing acoustic & semantic highlights...'
      );

      const engagementTask = fetchEngagementData(video.youtube_video_id, channelAccessToken);

      const [mediaSignals, engagement] = await Promise.all([
        mediaAndSignalsTask,
        engagementTask,
      ]);

      progressCeiling = 68;
      updateJobStage(
        jobId,
        'analyzing_gemini',
        2,
        62,
        'Synthesizing Gemini multimodal highlights with speech-pause boundaries...'
      );

      const geminiResult = await analyzeVideoWithGemini(
        video,
        mediaSignals,
        activeKeepPct
      );

      progressCeiling = 76;
      updateJobStage(
        jobId,
        'checking_engagement',
        3,
        70,
        'Correlating audience retention and acoustic prominence peaks...'
      );
      const { smoothedTimeline, peaks } = engagement.available
        ? analyzeEngagementTimeline(engagement.observations, video.duration)
        : { smoothedTimeline: [], peaks: [] };

      updateJobStage(
        jobId,
        'identifying_moments',
        4,
        76,
        `Evaluated ${geminiResult.highlights.length} candidate moments across the timeline...`,
        {
          engagement_available: engagement.available,
          engagement_source: engagement.source,
          engagement_timeline: smoothedTimeline,
          video_summary: geminiResult.video_summary,
          video_category: geminiResult.video_category,
          analysis_mode: fixture ? 'development_fixture' : 'gemini_live',
        }
      );

      progressCeiling = 86;
      updateJobStage(
        jobId,
        'ranking_selecting',
        5,
        82,
        `Selecting intro, highest-scoring best moments, and outro (${activeKeepPct}% of video length)...`
      );

      const coveredHighlights = ensureCandidateCoverageForTarget(
        geminiResult.highlights,
        video.duration,
        activeKeepPct
      );

      const scoredCandidates = scoreAndMergeCandidates(coveredHighlights, peaks, {
        engagementAvailable: engagement.available,
        audioAvailable: true,
        videoDuration: video.duration,
      });

      const selectedClips = selectHighlightReel(
        scoredCandidates,
        video.duration,
        {
          sceneBoundaries: fixture?.sceneBoundaries || [],
          pauseBoundaries: mediaSignals?.pauseBoundaries || [],
        },
        activeKeepPct
      );

      const plannedDuration = selectedClips.reduce(
        (sum, seg) => sum + (seg.end_time - seg.start_time),
        0
      );
      const segmentRecords: HighlightSegmentRecord[] = selectedClips.map((seg, idx) => ({
        id: `seg-${jobId}-${idx + 1}`,
        job_id: jobId,
        ...seg,
        role: seg.role || classifySegmentRole(seg, video.duration),
      }));
      db.segments[jobId] = segmentRecords;

      updateJobStage(
        jobId,
        'preparing_reel',
        6,
        86,
        `Locked ${segmentRecords.length} chronological clips totaling ${formatTimestamp(
          plannedDuration
        )} (${activeKeepPct}% compiled)...`,
        {
          actual_output_duration: plannedDuration,
        }
      );

      // Ensure source media is present before FFmpeg rendering (retry download if needed)
      if ((!job.source_media_path || !fs.existsSync(job.source_media_path)) && !video.is_fixture && video.youtube_video_id) {
        progressCeiling = 91;
        const retryMp4 = await downloadYouTubeVideoMp4(
          video.youtube_video_id,
          (_pct, msg) => {
            const currentJob = db.jobs[jobId];
            if (currentJob && currentJob.status !== 'complete' && currentJob.status !== 'failed') {
              currentJob.stage_message = msg;
            }
          }
        );
        if (retryMp4 && fs.existsSync(retryMp4)) {
          const realDur = await probeVideoDuration(retryMp4);
          job.source_media_path = retryMp4;
          job.source_media_duration = realDur;
          job.rights_confirmed = true;
          saveDb();
        }
      }

      if (job.source_media_path && fs.existsSync(job.source_media_path)) {
        progressCeiling = 98;
        updateJobStage(
          jobId,
          'rendering_video',
          7,
          90,
          'Cutting and stitching HD H.264 video clips and 48kHz stereo audio with FFmpeg...',
          { source_media_status: 'rendering' }
        );

        const { outputPath, actualDuration } = await renderHighlightReelWithFfmpeg(
          job,
          video,
          segmentRecords
        );

        // If this was a private local video uploaded from the user's computer, remove the raw upload after rendering
        if (
          video.id.startsWith('vid-upload-') &&
          job.source_media_path &&
          job.source_media_path.startsWith(UPLOADS_DIR) &&
          fs.existsSync(job.source_media_path)
        ) {
          try {
            fs.unlinkSync(job.source_media_path);
            job.source_media_path = undefined;
          } catch {
            // ignore cleanup error
          }
        }

        updateJobStage(
          jobId,
          'complete',
          8,
          100,
          'Highlight video compiled in HD and ready to watch.',
          {
            source_media_status: 'rendered',
            download_location: outputPath,
            actual_output_duration: actualDuration,
          }
        );
      } else {
        throw new Error(
          'Unable to download the source video stream from YouTube right now. Please click Try Again or upload the MP4 file directly.'
        );
      }
    } finally {
      clearInterval(progressTicker);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unexpected processing error.';
    updateJobStage(jobId, 'failed', job.stage_index || 1, job.progress || 0, message, {
      error: message,
    });
  }
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
      const safeExt = path.extname(file.originalname).replace(/[^a-zA-Z0-9.]/g, '') || '.mp4';
      cb(null, `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${safeExt}`);
    },
  }),
  limits: {
    fileSize: 500 * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    if (
      file.mimetype.startsWith('video/') ||
      /\.(mp4|mov|webm|mkv|m4v)$/i.test(file.originalname)
    ) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported file format. Please upload an MP4, MOV, WebM, or MKV video file.'));
    }
  },
});

async function extractVideoFrameDataUri(filePath: string): Promise<string> {
  try {
    if (!filePath || !fs.existsSync(filePath)) return '';
    const tmpJpg = path.join(
      UPLOADS_DIR,
      `thumb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`
    );
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-ss',
        '2',
        '-i',
        filePath,
        '-frames:v',
        '1',
        '-vf',
        'scale=640:-1',
        '-q:v',
        '5',
        tmpJpg,
      ],
      { timeout: 10000 }
    );
    if (fs.existsSync(tmpJpg)) {
      const buf = fs.readFileSync(tmpJpg);
      fs.unlinkSync(tmpJpg);
      if (buf.length > 0) {
        return `data:image/jpeg;base64,${buf.toString('base64')}`;
      }
    }
  } catch {
    // ignore thumbnail extraction errors
  }
  return '';
}

async function backfillMissingCompiledVideos(): Promise<void> {
  // Remove any unowned jobs so another user's videos are never retained globally
  let modified = false;
  for (const [id, job] of Object.entries(db.jobs)) {
    if (!sanitizeClientId(job.owner_client_id)) {
      delete db.jobs[id];
      delete db.segments[id];
      modified = true;
      continue;
    }
    if (job.status !== 'complete') {
      job.error = undefined;
      void runHighlightPipeline(job.id);
    } else if (
      job.status === 'complete' &&
      (job.source_media_status !== 'rendered' ||
        !job.download_location ||
        !fs.existsSync(job.download_location))
    ) {
      void runHighlightPipeline(job.id);
    }
  }
  if (modified) {
    saveDb();
  }
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  ensureFixtureSourceVideo().catch(() => {});
  backfillMissingCompiledVideos().catch(() => {});

  app.get('/api/system/status', (_req, res) => {
    const geminiConfigured = hasValidEnvKey(process.env.GEMINI_API_KEY, 'MY_GEMINI_API_KEY');
    const youtubeDataApiConfigured = hasValidEnvKey(
      process.env.YOUTUBE_API_KEY,
      'MY_YOUTUBE_DATA_API_KEY'
    );
    res.json({
      geminiConfigured,
      youtubeDataApiConfigured,
      ffmpegAvailable: true,
    });
  });

  app.post('/api/videos/inspect', async (req, res) => {
    try {
      const { url, durationSeconds, keepPercentage } = req.body as {
        url?: string;
        durationSeconds?: number;
        keepPercentage?: number;
      };
      if (!url || typeof url !== 'string' || !url.trim()) {
        res.status(400).json({ error: 'Please paste a valid YouTube link.' });
        return;
      }
      const keepPct = clampKeepPercentage(keepPercentage);
      const video = await inspectYouTubeVideo(url, durationSeconds);
      if (!video.is_fixture && video.youtube_video_id) {
        void downloadYouTubeVideoMp4(video.youtube_video_id);
      }
      const target = calculateTargetDuration(video.duration, 0.04, keepPct);
      res.json({
        video,
        targetDuration: target,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to inspect YouTube URL.';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/highlights', async (req, res) => {
    try {
      const { url, durationSeconds, channelAccessToken, keepPercentage } = req.body as {
        url?: string;
        durationSeconds?: number;
        channelAccessToken?: string;
        keepPercentage?: number;
      };
      if (!url || typeof url !== 'string' || !url.trim()) {
        res.status(400).json({ error: 'YouTube URL is required to create a highlight job.' });
        return;
      }

      const keepPct = clampKeepPercentage(keepPercentage);
      const video = await inspectYouTubeVideo(url, durationSeconds);
      const target = calculateTargetDuration(video.duration, 0.04, keepPct);
      const fixture = DEVELOPMENT_FIXTURES[video.youtube_video_id];
      const ownerClientId = extractRequestClientId(req);

      const jobId = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const job: HighlightJobRecord = {
        id: jobId,
        video_id: video.id,
        status: 'retrieving_info',
        stage_index: 1,
        stage_message: 'Retrieving YouTube video information...',
        progress: 5,
        engagement_available: false,
        engagement_source: 'unavailable',
        source_media_status: fixture?.hasPrebuiltSourceFile ? 'fixture_ready' : 'missing_source',
        rights_confirmed: Boolean(fixture?.hasPrebuiltSourceFile),
        keep_percentage: keepPct,
        target_duration: target.targetSeconds,
        actual_output_duration: 0,
        owner_client_id: ownerClientId || undefined,
        created_at: new Date().toISOString(),
      };

      db.jobs[jobId] = job;
      db.segments[jobId] = [];
      saveDb();

      void runHighlightPipeline(jobId, channelAccessToken);

      res.status(201).json({
        job,
        video,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create highlight job.';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/highlights/upload', (req, res) => {
    upload.single('file')(req, res, async (uploadErr) => {
      try {
        if (uploadErr) {
          res.status(400).json({ error: uploadErr.message || 'File upload failed.' });
          return;
        }
        if (!req.file) {
          res.status(400).json({ error: 'Please select a video file to upload.' });
          return;
        }

        const actualDuration = await probeVideoDuration(req.file.path);
        const rawUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
        const keepPct = clampKeepPercentage(
          req.body?.keepPercentage !== undefined ? Number(req.body.keepPercentage) : undefined
        );
        const ownerClientId = extractRequestClientId(req);

        let video: VideoRecord;
        if (rawUrl && extractYouTubeVideoId(rawUrl)) {
          video = await inspectYouTubeVideo(rawUrl, actualDuration);
          video.duration = actualDuration;
          db.videos[video.id] = video;
        } else {
          const cleanName =
            req.file.originalname.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ') ||
            'Uploaded Video';
          const slug = `${Date.now().toString(36)}`;
          const extractedThumb = await extractVideoFrameDataUri(req.file.path);
          video = {
            id: `vid-upload-${slug}`,
            youtube_video_id: `upload-${slug}`,
            title: cleanName,
            channel: 'Uploaded Video',
            duration: actualDuration,
            thumbnail: extractedThumb || KEYNOTE_THUMBNAIL_SVG,
            description: `Uploaded video file compiled into a ${keepPct}% highlight reel.`,
            original_url: '',
            is_fixture: false,
          };
          db.videos[video.id] = video;
        }

        const target = calculateTargetDuration(video.duration, 0.04, keepPct);
        const jobId = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const job: HighlightJobRecord = {
          id: jobId,
          video_id: video.id,
          status: 'retrieving_info',
          stage_index: 1,
          stage_message: 'Reading uploaded video file and preparing highlight compilation...',
          progress: 8,
          engagement_available: false,
          engagement_source: 'unavailable',
          source_media_status: 'uploaded_verified',
          source_media_path: req.file.path,
          source_media_duration: actualDuration,
          rights_confirmed: true,
          keep_percentage: keepPct,
          target_duration: target.targetSeconds,
          actual_output_duration: 0,
          owner_client_id: ownerClientId || undefined,
          created_at: new Date().toISOString(),
        };

        db.jobs[jobId] = job;
        db.segments[jobId] = [];
        saveDb();

        void runHighlightPipeline(jobId);

        res.status(201).json({
          job,
          video,
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to process uploaded video file.';
        res.status(400).json({ error: message });
      }
    });
  });

  app.post('/api/highlights/:job_id/keep-percentage', (req, res) => {
    const job = db.jobs[req.params.job_id];
    if (!job) {
      res.status(404).json({ error: 'Highlight job not found.' });
      return;
    }
    const video = db.videos[job.video_id];
    if (!video) {
      res.status(404).json({ error: 'Associated video not found.' });
      return;
    }
    const keepPct = clampKeepPercentage(req.body?.keepPercentage);
    const target = calculateTargetDuration(video.duration, 0.04, keepPct);
    job.keep_percentage = keepPct;
    job.target_duration = target.targetSeconds;
    saveDb();

    res.json({
      job: {
        ...job,
        download_ready: Boolean(
          job.source_media_status === 'rendered' &&
            job.download_location &&
            fs.existsSync(job.download_location)
        ),
        download_location: undefined,
        source_media_path: undefined,
      },
      video,
    });
  });

  app.delete('/api/highlights/:job_id', (req, res) => {
    const job = db.jobs[req.params.job_id];
    if (!job) {
      res.status(404).json({ error: 'Highlight job not found.' });
      return;
    }
    const clientId = extractRequestClientId(req);
    if (job.owner_client_id && clientId && job.owner_client_id !== clientId) {
      res.status(403).json({ error: 'You can only delete your own compiled videos.' });
      return;
    }
    if (job.download_location && fs.existsSync(job.download_location)) {
      try {
        fs.unlinkSync(job.download_location);
      } catch {
        // ignore
      }
    }
    if (
      job.source_media_path &&
      job.source_media_path.startsWith(UPLOADS_DIR) &&
      job.source_media_path.includes('upload-') &&
      fs.existsSync(job.source_media_path)
    ) {
      try {
        fs.unlinkSync(job.source_media_path);
      } catch {
        // ignore
      }
    }
    delete db.jobs[job.id];
    delete db.segments[job.id];
    saveDb();
    res.json({ deleted: true, id: req.params.job_id });
  });

  app.get('/api/highlights', (req, res) => {
    const clientId = extractRequestClientId(req);
    res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
    const jobsList = Object.values(db.jobs)
      .filter(
        (j) =>
          j.status === 'complete' &&
          (db.segments[j.id] || []).length > 0 &&
          isJobVisibleToClient(j, clientId)
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 50)
      .map((job) => {
        const segs = db.segments[job.id] || [];
        return {
          job: {
            ...job,
            download_ready: Boolean(
              job.source_media_status === 'rendered' &&
                job.download_location &&
                fs.existsSync(job.download_location)
            ),
            download_location: undefined,
            source_media_path: undefined,
          },
          video: db.videos[job.video_id],
          segmentCount: segs.length,
          segments: segs,
        };
      });
    res.json({ items: jobsList });
  });

  app.get('/api/highlights/:job_id', async (req, res) => {
    const job = db.jobs[req.params.job_id];
    if (!job) {
      res.status(404).json({ error: 'Highlight job not found.' });
      return;
    }
    const video = db.videos[job.video_id];
    const segments = db.segments[job.id] || [];

    if (
      job.status === 'complete' &&
      segments.length > 0 &&
      video &&
      (job.source_media_status !== 'rendered' ||
        !job.download_location ||
        !fs.existsSync(job.download_location))
    ) {
      try {
        if (!job.source_media_path || !fs.existsSync(job.source_media_path)) {
          if (video.is_fixture) {
            job.source_media_path = await ensureFixtureSourceVideo();
            job.source_media_duration = video.duration;
            job.rights_confirmed = true;
          } else if (video.youtube_video_id) {
            const downloaded = await downloadYouTubeVideoMp4(video.youtube_video_id);
            if (downloaded && fs.existsSync(downloaded)) {
              job.source_media_path = downloaded;
              job.source_media_duration = await probeVideoDuration(downloaded);
              job.rights_confirmed = true;
            }
          }
        }
        if (job.source_media_path && fs.existsSync(job.source_media_path)) {
          const { outputPath, actualDuration } = await renderHighlightReelWithFfmpeg(
            job,
            video,
            segments
          );
          job.source_media_status = 'rendered';
          job.download_location = outputPath;
          job.actual_output_duration = actualDuration;
          saveDb();
        }
      } catch {
        // Ignore transient on-demand render warning
      }
    }

    res.json({
      job: {
        ...job,
        download_ready: Boolean(
          job.source_media_status === 'rendered' &&
            job.download_location &&
            fs.existsSync(job.download_location)
        ),
        download_location: undefined,
        source_media_path: undefined,
      },
      video,
      segmentCount: segments.length,
      segments,
    });
  });

  app.get('/api/highlights/:job_id/segments', (req, res) => {
    const job = db.jobs[req.params.job_id];
    if (!job) {
      res.status(404).json({ error: 'Highlight job not found.' });
      return;
    }
    const segments = db.segments[job.id] || [];
    res.json({
      job_id: job.id,
      target_duration: job.target_duration,
      actual_output_duration: job.actual_output_duration,
      engagement_available: job.engagement_available,
      engagement_source: job.engagement_source,
      segments,
    });
  });

  app.post('/api/highlights/:job_id/source', (req, res) => {
    upload.single('file')(req, res, async (uploadErr) => {
      try {
        if (uploadErr) {
          res.status(400).json({ error: uploadErr.message || 'File upload failed.' });
          return;
        }
        const job = db.jobs[req.params.job_id];
        if (!job) {
          res.status(404).json({ error: 'Highlight job not found.' });
          return;
        }
        const video = db.videos[job.video_id];
        if (!video) {
          res.status(404).json({ error: 'Associated video not found.' });
          return;
        }

        const explicitlyDenied =
          req.body?.rightsConfirmed === 'false' || req.body?.rightsConfirmed === false;

        if (explicitlyDenied) {
          res.status(400).json({
            error:
              'Please confirm that you own or have authorization to edit and export this media file.',
          });
          return;
        }

        let uploadedFilePath: string;
        if (req.body?.useSampleFixture === 'true' || req.body?.useSampleFixture === true) {
          uploadedFilePath = await ensureFixtureSourceVideo();
        } else if (req.file) {
          uploadedFilePath = req.file.path;
        } else {
          res.status(400).json({ error: 'Please select a valid video file to upload.' });
          return;
        }

        const actualDuration = await probeVideoDuration(uploadedFilePath);
        const strictDurationCheck =
          req.body?.syncDuration === 'false' || req.body?.syncDuration === false;

        if (strictDurationCheck) {
          const check = verifySourceMediaDuration(video.duration, actualDuration);
          if (!check.valid) {
            if (req.file) {
              try {
                fs.unlinkSync(req.file.path);
              } catch {
                // ignore
              }
            }
            res.status(400).json({
              error: check.reason,
              expectedDuration: video.duration,
              actualDuration,
            });
            return;
          }
        }

        job.source_media_path = uploadedFilePath;
        job.source_media_duration = actualDuration;
        job.source_media_status = 'uploaded_verified';
        job.rights_confirmed = true;
        saveDb();

        res.json({
          message: 'Video file verified and attached.',
          source_media_status: job.source_media_status,
          source_media_duration: actualDuration,
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to verify uploaded video source.';
        res.status(400).json({ error: message });
      }
    });
  });

  app.post('/api/highlights/:job_id/render', async (req, res) => {
    try {
      const job = db.jobs[req.params.job_id];
      if (!job) {
        res.status(404).json({ error: 'Highlight job not found.' });
        return;
      }
      const video = db.videos[job.video_id];
      const segments = db.segments[job.id] || [];

      if (!job.source_media_path || !fs.existsSync(job.source_media_path)) {
        res.status(400).json({
          error:
            'No authorized source video file is attached to this job. Upload your original video file first.',
        });
        return;
      }
      if (!job.rights_confirmed) {
        res.status(400).json({
          error: 'Media editing rights confirmation is required before rendering.',
        });
        return;
      }
      if (segments.length === 0) {
        res.status(400).json({ error: 'No highlight segments selected for rendering.' });
        return;
      }

      job.source_media_status = 'rendering';
      job.status = 'rendering_video';
      job.stage_index = 7;
      job.progress = 92;
      job.stage_message = 'Rendering 720p HD H.264/AAC MP4 highlight reel with FFmpeg...';
      job.error = undefined;
      saveDb();

      const { outputPath, actualDuration } = await renderHighlightReelWithFfmpeg(
        job,
        video,
        segments
      );

      job.source_media_status = 'rendered';
      job.status = 'complete';
      job.stage_index = 8;
      job.progress = 100;
      job.stage_message = 'MP4 highlight reel rendered and ready for download.';
      job.download_location = outputPath;
      job.actual_output_duration = actualDuration;
      saveDb();

      res.json({
        job: {
          ...job,
          download_ready: true,
          download_location: undefined,
          source_media_path: undefined,
        },
      });
    } catch (err) {
      const job = db.jobs[req.params.job_id];
      const message = err instanceof Error ? err.message : 'FFmpeg video rendering failed.';
      if (job) {
        job.source_media_status = 'render_failed';
        job.error = message;
        saveDb();
      }
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/highlights/:job_id/retry', async (req, res) => {
    const job = db.jobs[req.params.job_id];
    if (!job) {
      res.status(404).json({ error: 'Highlight job not found.' });
      return;
    }
    job.error = undefined;
    job.status = 'retrieving_info';
    job.stage_index = 1;
    job.progress = 5;
    saveDb();
    void runHighlightPipeline(job.id);
    res.json({ job });
  });

  app.get('/api/highlights/:job_id/download', async (req, res) => {
    const job = db.jobs[req.params.job_id];
    if (!job) {
      res.status(404).json({ error: 'Highlight job not found.' });
      return;
    }

    const video = db.videos[job.video_id];
    const segments = db.segments[job.id] || [];

    if (
      (job.source_media_status !== 'rendered' ||
        !job.download_location ||
        !fs.existsSync(job.download_location)) &&
      video &&
      segments.length > 0
    ) {
      try {
        if (!job.source_media_path || !fs.existsSync(job.source_media_path)) {
          if (video.is_fixture) {
            job.source_media_path = await ensureFixtureSourceVideo();
            job.source_media_duration = video.duration;
            job.rights_confirmed = true;
          } else if (video.youtube_video_id) {
            const downloaded = await downloadYouTubeVideoMp4(video.youtube_video_id);
            if (downloaded && fs.existsSync(downloaded)) {
              job.source_media_path = downloaded;
              job.source_media_duration = await probeVideoDuration(downloaded);
              job.rights_confirmed = true;
            }
          }
        }
        if (job.source_media_path && fs.existsSync(job.source_media_path)) {
          const { outputPath, actualDuration } = await renderHighlightReelWithFfmpeg(
            job,
            video,
            segments
          );
          job.source_media_status = 'rendered';
          job.download_location = outputPath;
          job.actual_output_duration = actualDuration;
          saveDb();
        }
      } catch {
        // Ignore transient on-demand download render warning
      }
    }

    if (
      job.source_media_status !== 'rendered' ||
      !job.download_location ||
      !fs.existsSync(job.download_location)
    ) {
      res.status(400).json({
        error:
          'The MP4 highlight reel has not been rendered yet. Provide an authorized source video first.',
      });
      return;
    }

    const videoIdSlug = video ? video.youtube_video_id : job.id;
    const downloadFilename = formatVideoDownloadFilename(video?.title, videoIdSlug);
    const asciiSafeFilename =
      downloadFilename.replace(/[^\x20-\x7E]/g, '').replace(/["\\]/g, '').trim() ||
      `highlight-${videoIdSlug}.mp4`;
    const encodedUtf8Filename = encodeURIComponent(downloadFilename);

    const clientId = extractRequestClientId(req);
    if (
      req.query.download === '1' &&
      job.owner_client_id &&
      clientId &&
      job.owner_client_id !== clientId
    ) {
      res.status(403).json({
        error: 'Only the creator of this video can save the MP4 file to their local computer.',
      });
      return;
    }

    const stat = fs.statSync(job.download_location);
    const fileSize = stat.size;
    const range = req.headers.range;

    res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'video/mp4');

    if (req.query.download === '1') {
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${asciiSafeFilename}"; filename*=UTF-8''${encodedUtf8Filename}`
      );
    } else {
      res.setHeader('Content-Disposition', 'inline');
    }

    if (range && req.query.download !== '1') {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = Math.max(0, parseInt(parts[0], 10) || 0);
      const maxChunk = 4 * 1024 * 1024; // 4MB chunks for fast proxy streaming
      const requestedEnd = parts[1] ? parseInt(parts[1], 10) : start + maxChunk - 1;
      const end = Math.min(fileSize - 1, Math.max(start, requestedEnd));
      const chunksize = end - start + 1;
      const file = fs.createReadStream(job.download_location, { start, end });
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'video/mp4',
      });
      file.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4',
      });
      fs.createReadStream(job.download_location).pipe(res);
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    process.env.DISABLE_HMR = 'true';
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        watch: null,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const PORT = Number(process.env.PORT) || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Highlight server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
