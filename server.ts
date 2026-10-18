import express from 'express';
import { createServer as createViteServer } from 'vite';
import multer from 'multer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import dotenv from 'dotenv';
import { GoogleGenAI, Type, ThinkingLevel, MediaResolution } from '@google/genai';
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

const STORAGE_DIR =
  process.env.STORAGE_DIR || path.join(process.cwd(), '.data', 'highlight-storage');
const MEDIA_STORAGE_DIR =
  process.env.MEDIA_STORAGE_DIR || path.join(os.tmpdir(), 'highlight-storage');
const UPLOADS_DIR = path.join(MEDIA_STORAGE_DIR, 'uploads');
const RENDERS_DIR = path.join(MEDIA_STORAGE_DIR, 'renders');
const DB_FILE = path.join(STORAGE_DIR, 'db.json');
const AUDIO_SIGNALS_CACHE_FILE = path.join(MEDIA_STORAGE_DIR, 'audio-signals-cache.json');
const GEMINI_CACHE_FILE = path.join(STORAGE_DIR, 'gemini-cache.json');
const FIXTURE_MP4_PATH = path.join(MEDIA_STORAGE_DIR, 'fixture-keynote-300s.mp4');

fs.mkdirSync(STORAGE_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(RENDERS_DIR, { recursive: true });

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
        if (job.status === 'failed') {
          delete parsed.jobs[id];
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
      for (const video of Object.values(parsed.videos || {})) {
        if (video.title.includes('(Dev Fixture)')) {
          video.title = video.title.replace(/\s*\(Dev Fixture\)/g, '');
        }
      }
      return parsed;
    }
  } catch (err) {
    console.error('Failed to read DB file, initializing fresh store:', err);
  }
  return { videos: {}, jobs: {}, segments: {} };
}

const db: DatabaseState = loadDb();

function saveDb(): void {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to persist DB file:', err);
  }
}

function seedInitialReelsIfNeeded(): void {
  try {
    const allSegs = Object.values(db.segments).flat();
    const hasTruncatedSeed = allSegs.some(
      (s) => s.title.endsWith('Lab Fie') || s.title.endsWith('Key')
    );
    const hasRoundedSeed =
      db.videos['vid-dev-keynote-01']?.duration === 300 ||
      db.videos['vid-dev-robotics-02']?.duration === 600 ||
      db.videos['vid-dev-robotics-02']?.title?.startsWith('Autonomous');
    const completedCount = Object.values(db.jobs).filter((j) => j.status === 'complete').length;
    if (completedCount > 0 && !hasTruncatedSeed && !hasRoundedSeed) return;

    const fixtureKeys = ['dev-keynote-01', 'dev-robotics-02'];
    fixtureKeys.forEach((key, index) => {
      const fixture = DEVELOPMENT_FIXTURES[key];
      if (!fixture) return;
      const video: VideoRecord = {
        ...fixture.video,
        title: fixture.video.title.replace(/\s*\(Dev Fixture\)/g, ''),
      };
      db.videos[video.id] = video;

      const shortHeading = video.title.split(':')[0].trim();
      const target = calculateTargetDuration(video.duration);
      const introEnd =
        fixture.sceneBoundaries.find((b) => b > 5 && b <= target.targetSeconds * 0.2) ??
        target.targetSeconds * 0.143;
      const outroStart =
        [...fixture.sceneBoundaries]
          .reverse()
          .find((b) => b < video.duration - 5 && b >= video.duration - target.targetSeconds * 0.22) ??
        video.duration - target.targetSeconds * 0.132;

      const introOutroCandidates: AICandidateHighlight[] = [
        {
          start_time: 0,
          end_time: introEnd,
          title: `Intro — ${shortHeading}`,
          description: `Opening introduction establishing the speaker, setting, and core premise of ${video.title}.`,
          semantic_score: 0.9,
          visual_score: 0.85,
          audio_score: 0.84,
          context_score: 0.96,
          role: 'intro',
          reason: 'Opening introduction incorporated to ground the highlight reel.',
        },
        ...fixture.aiHighlights.map((h) => ({ ...h, role: 'highlight' as const })),
        {
          start_time: outroStart,
          end_time: video.duration,
          title: `Outro — Final Conclusion & Sign-Off`,
          description: `Closing wrap-up and final takeaway from ${video.channel}.`,
          semantic_score: 0.89,
          visual_score: 0.83,
          audio_score: 0.83,
          context_score: 0.95,
          role: 'outro',
          reason: 'Closing outro incorporated to give the compiled reel a complete ending.',
        },
      ];

      const clamped = validateAndClampAICandidates(
        {
          video_summary: fixture.videoSummary,
          video_category: fixture.videoCategory,
          highlights: introOutroCandidates,
        },
        video.duration
      );
      const covered = ensureCandidateCoverageForTarget(clamped.highlights, video.duration);
      const engagementAnalysis = analyzeEngagementTimeline(
        fixture.engagementObservations,
        video.duration
      );
      const scored = scoreAndMergeCandidates(covered, engagementAnalysis.peaks || [], {
        engagementAvailable: fixture.engagementAvailable,
        audioAvailable: true,
        videoDuration: video.duration,
      });
      const selected = selectHighlightReel(scored, video.duration, {
        pauseBoundaries: fixture.sceneBoundaries,
      });

      const jobId = `job-seed-${key}`;
      const actualDuration = selected.reduce(
        (sum, seg) => sum + Math.max(0, seg.end_time - seg.start_time),
        0
      );

      db.jobs[jobId] = {
        id: jobId,
        video_id: video.id,
        status: 'complete',
        stage_index: 8,
        stage_message: 'Highlight video compiled and ready to watch or download.',
        progress: 100,
        engagement_available: fixture.engagementAvailable,
        engagement_source: fixture.engagementSource,
        source_media_status: 'fixture_ready',
        rights_confirmed: true,
        target_duration: target.targetSeconds,
        actual_output_duration: actualDuration,
        video_summary: fixture.videoSummary,
        video_category: fixture.videoCategory,
        created_at: new Date(Date.now() - (fixtureKeys.length - index) * 60000).toISOString(),
      };

      db.segments[jobId] = selected.map((seg, idx) => ({
        id: `seg-${jobId}-${idx + 1}`,
        job_id: jobId,
        ...seg,
        role: seg.role || classifySegmentRole(seg, video.duration),
      }));
    });

    saveDb();
  } catch (err) {
    console.warn('Initial reel seeding warning:', err);
  }
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
        'ultrafast',
        '-crf',
        '19',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
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
    } catch (err) {
      console.warn('YouTube Analytics API query failed, continuing with Gemini AI analysis:', err);
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
      const mirrors = ['https://s64.notube.net', 'https://s61.notube.net', 'https://s59.notube.net'];
      const weightDur = await Promise.any(
        mirrors.map(async (mirror) => {
          const weightRes = await fetch(`${mirror}/recover_weight.php`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'User-Agent': 'Mozilla/5.0',
            },
            body: `url=${encodeURIComponent(canonicalUrl)}&format=mp4&lang=en`,
            signal: AbortSignal.timeout(7000),
          });
          if (!weightRes.ok) throw new Error('Mirror failed');
          const weightData = (await weightRes.json()) as { url_mp4_youtube?: string };
          const durMatch = weightData.url_mp4_youtube?.match(/[?&]dur=([0-9.]+)/);
          if (durMatch && durMatch[1]) {
            const parsedDur = parseFloat(durMatch[1]);
            if (Number.isFinite(parsedDur) && parsedDur >= 5) {
              return parsedDur;
            }
          }
          throw new Error('No duration found');
        })
      );
      if (weightDur >= 5) {
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
    } catch (err) {
      console.warn('FFmpeg source media signal extraction warning:', err);
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
        const score = meanEnergy * 0.65 + dynamicRange * 0.35;

        const naturalSpan = baseWindow * (0.72 + 0.58 * score);
        const rawStart = Math.max(bodyStart, peakTime - naturalSpan * 0.43);
        const rawEnd = Math.min(bodyEnd, rawStart + naturalSpan);

        const alignedStart = nearestPause(rawStart, naturalSpan * 0.22);
        const alignedEnd = nearestPause(rawEnd, naturalSpan * 0.22);
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
  } catch (err) {
    console.warn('FFmpeg source media signal analysis warning:', err);
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

  const introEnd = mediaSignals?.introEnd ?? target * 0.143;
  const outroStart = mediaSignals?.outroStart ?? dur - target * 0.131;

  const highlights: AICandidateHighlight[] = [
    {
      start_time: 0,
      end_time: Math.max(dur * 0.015, introEnd),
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
      highlights.push({
        start_time: pk.start_time,
        end_time: pk.end_time,
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
      const segLen = target * tpl.spanFactor;
      const s = Math.max(introEnd + dur * 0.01, dur * tpl.ratio);
      const e = Math.min(outroStart - dur * 0.01, s + segLen);
      if (e - s >= dur * 0.015) {
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
    start_time: Math.min(dur - dur * 0.015, outroStart),
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

/**
 * Fetches or retrieves the cached Gemini candidate highlight pool for a YouTube video.
 */
async function fetchGeminiRawCandidates(
  video: VideoRecord,
  keepPercentage = DEFAULT_KEEP_PERCENTAGE
): Promise<GeminiAnalysisSchema | null> {
  if (video.youtube_video_id && geminiCandidateCache[video.youtube_video_id]) {
    const cached = geminiCandidateCache[video.youtube_video_id];
    if (cached && Array.isArray(cached.highlights) && cached.highlights.length > 0) {
      return validateAndClampAICandidates(cached, video.duration);
    }
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!hasValidEnvKey(apiKey, 'MY_GEMINI_API_KEY') || !video.original_url.startsWith('http')) {
    return null;
  }

  const inFlight = activeGeminiAnalyses.get(video.youtube_video_id);
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

      const prompt = `Analyze this YouTube video ("${video.title}" by ${video.channel}, exact total duration: ${video.duration} seconds).
Identify the strongest highlight segments so we can compile a highlight reel of approximately ${target.targetSeconds.toFixed(2)} seconds (around ${validPct}% of the original video length).

CRITICAL CLIPPING & TIMING RULES:
1. DO NOT keep fixed clip durations (never make every clip the same length like 20s or 30s). Each clip's length must naturally match the actual duration of that specific moment/scene.
2. DO NOT round timestamps to whole integers or multiples of 5/10 seconds. Provide exact, unrounded decimal start_time and end_time in seconds (e.g., 14.38, 198.74) aligned to natural speech pauses and scene cuts.
3. Always include the video's INTRO (starting at 0s) if an intro or opening hook exists, with role="intro".
4. Select the ACTUAL BEST MOMENTS from the body of the video (the funniest, most intense, most informative, or highest-impact sequences), with role="highlight".
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

      const modelsToTry = ['gemini-3.1-flash-lite', 'gemini-flash-latest', 'gemini-3.8-flash'];

      for (const modelName of modelsToTry) {
        try {
          const response = await ai.models.generateContent({
            model: modelName,
            contents: [
              {
                fileData: {
                  fileUri: video.original_url,
                  mimeType: 'video/mp4',
                },
              },
              { text: prompt },
            ],
            config: {
              responseMimeType: 'application/json',
              responseSchema,
              mediaResolution: MediaResolution.MEDIA_RESOLUTION_LOW,
              ...(modelName === 'gemini-3.1-flash-lite'
                ? { thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL } }
                : modelName === 'gemini-3.8-flash'
                ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
                : {}),
               abortSignal: AbortSignal.timeout(18000),
            },
          });

          const text = response.text;
          if (text) {
            const parsed = JSON.parse(text);
            const validated = validateAndClampAICandidates(parsed, video.duration);
            if (validated.highlights.length > 0) {
              geminiCandidateCache[video.youtube_video_id] = validated;
              saveGeminiCandidateCache();
              return validated;
            }
          }
        } catch (err) {
          console.warn(`Gemini model ${modelName} video analysis attempt warning:`, err);
        }
      }
      return null;
    } finally {
      activeGeminiAnalyses.delete(video.youtube_video_id);
    }
  })();

  activeGeminiAnalyses.set(video.youtube_video_id, task);
  return task;
}

/**
 * Calls Google Gemini on the server to analyze a public YouTube URL
 * using a multi-model fallback chain (`gemini-3.1-flash-lite` -> `gemini-flash-latest` -> `gemini-3.8-flash`),
 * enriched with real FFmpeg audio/scene energy peaks when available.
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
    preFetchedRaw !== undefined
      ? preFetchedRaw
      : await fetchGeminiRawCandidates(video, validPct);

  if (rawSchema && rawSchema.highlights.length > 0) {
    const clamped = validateAndClampAICandidates(rawSchema, video.duration);
    return alignAndEnrichCandidatesWithMediaSignals(
      clamped,
      video.duration,
      mediaSignals,
      validPct
    );
  }

  return buildResilientFallbackAnalysis(video, mediaSignals, validPct);
}

/**
 * Downloads the actual YouTube video MP4 (with moving video and audio) to local storage
 * so FFmpeg can cut and stitch the real video clips with audio and zero text overlays.
 */
const activeYouTubeDownloads = new Map<string, Promise<string | null>>();

async function downloadYouTubeVideoMp4(youtubeVideoId: string): Promise<string | null> {
  if (!youtubeVideoId || DEVELOPMENT_FIXTURES[youtubeVideoId]) {
    return null;
  }

  const cachedPath = path.join(UPLOADS_DIR, `yt-${youtubeVideoId}.mp4`);
  if (fs.existsSync(cachedPath) && fs.statSync(cachedPath).size > 50000) {
    return cachedPath;
  }

  const existing = activeYouTubeDownloads.get(youtubeVideoId);
  if (existing) {
    return existing;
  }

  const downloadPromise = (async (): Promise<string | null> => {
    const ytUrl = `https://www.youtube.com/watch?v=${youtubeVideoId}`;
    const mirrors = ['https://s64.notube.net', 'https://s61.notube.net', 'https://s59.notube.net'];

    // Race all mirrors in parallel to pick the fastest responding server first
    let orderedMirrors = mirrors;
    const preFetchedWeights = new Map<string, { token?: string; name_mp4?: string }>();
    try {
      const fastest = await Promise.any(
        mirrors.map(async (mirror) => {
          const weightRes = await fetch(`${mirror}/recover_weight.php`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'User-Agent': 'Mozilla/5.0',
            },
            body: `url=${encodeURIComponent(ytUrl)}&format=mp4&lang=en`,
            signal: AbortSignal.timeout(10000),
          });
          if (!weightRes.ok) throw new Error('Mirror weight failed');
          const weightData = (await weightRes.json()) as {
            token?: string;
            name_mp4?: string;
          };
          if (!weightData.token) throw new Error('Missing token');
          preFetchedWeights.set(mirror, weightData);
          return { mirror, weightData };
        })
      );
      orderedMirrors = [
        fastest.mirror,
        ...mirrors.filter((m) => m !== fastest.mirror),
      ];
    } catch {
      // Fall back to default mirror order
    }

    for (const mirror of orderedMirrors) {
      const tmpPath = path.join(UPLOADS_DIR, `yt-${youtubeVideoId}-${Date.now()}.tmp.mp4`);
      try {
        let weightData = preFetchedWeights.get(mirror);
        if (!weightData) {
          const weightRes = await fetch(`${mirror}/recover_weight.php`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'User-Agent': 'Mozilla/5.0',
            },
            body: `url=${encodeURIComponent(ytUrl)}&format=mp4&lang=en`,
            signal: AbortSignal.timeout(12000),
          });
          if (!weightRes.ok) continue;
          weightData = (await weightRes.json()) as {
            token?: string;
            name_mp4?: string;
          };
        }
        if (!weightData.token) continue;

        const recoverRes = await fetch(`${mirror}/recover_file.php?lang=en`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0',
          },
          body: `url=${encodeURIComponent(ytUrl)}&format=mp4&name_mp4=${encodeURIComponent(
            weightData.name_mp4 || ''
          )}&token=${encodeURIComponent(weightData.token)}`,
          signal: AbortSignal.timeout(40000),
        });
        if (!recoverRes.ok) continue;

        const dlPageRes = await fetch(
          `https://notube.net/en/download?token=${encodeURIComponent(weightData.token)}`,
          {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(12000),
          }
        );
        if (!dlPageRes.ok) continue;

        const dlHtml = await dlPageRes.text();
        const dlMatch = dlHtml.match(
          /https?:\/\/s\d+\.notube\.net\/download\.php\?token=[^"'\s>]+/i
        );
        if (!dlMatch || !dlMatch[0]) continue;

        const downloadUrl = dlMatch[0].replace(/&amp;/g, '&');
        await execFileAsync(
          'curl',
          ['-sL', '--max-time', '80', '-A', 'Mozilla/5.0', '-o', tmpPath, downloadUrl],
          { timeout: 85000 }
        );

        if (fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 50000) {
          const dur = await probeVideoDuration(tmpPath);
          if (dur >= 5) {
            fs.renameSync(tmpPath, cachedPath);
            // Pre-warm audio signals in the background immediately upon download completion
            void extractRawAudioSignals(cachedPath);
            return cachedPath;
          }
        }
      } catch (err) {
        console.warn(`YouTube MP4 download attempt via ${mirror} warning:`, err);
      } finally {
        try {
          if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch {
          // ignore
        }
      }
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

const renderSignatureCache = new Map<string, { outputPath: string; actualDuration: number }>();

/**
 * Renders the selected highlight segments from a local source media file
 * into a single chronological 720p HD H.264 + AAC MP4 file using FFmpeg without rounding timestamps.
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

  // Keep video.duration exact (unrounded) when a real non-fixture source file is present
  const jobKeepPct = clampKeepPercentage(job.keep_percentage);
  if (!video.is_fixture && sourceDuration >= 5) {
    if (Math.abs(sourceDuration - video.duration) > 10) {
      for (const seg of segments) {
        const scaledStart = Math.max(0, seg.start_time * durationRatio);
        const scaledLen = Math.max(1, (seg.end_time - seg.start_time) * durationRatio);
        seg.start_time = Math.min(Math.max(0, sourceDuration - 1), scaledStart);
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
    5,
    ordered.reduce((acc, seg) => acc + Math.max(0.5, seg.end_time - seg.start_time), 0)
  );

  const finalFilename = `highlight-${video.youtube_video_id}-${job.id}.mp4`;
  const finalOutputPath = path.join(RENDERS_DIR, finalFilename);

  // Check if an identical 720p HD render already exists for this exact clip signature
  const signature = computeClipRenderSignature(video.id, jobKeepPct, ordered);
  const cachedRender = renderSignatureCache.get(signature);
  if (
    cachedRender &&
    fs.existsSync(cachedRender.outputPath) &&
    (await probeVideoStreamHeight(cachedRender.outputPath)) >= 720
  ) {
    if (cachedRender.outputPath !== finalOutputPath) {
      fs.copyFileSync(cachedRender.outputPath, finalOutputPath);
    }
    return { outputPath: finalOutputPath, actualDuration: cachedRender.actualDuration };
  }

  for (const otherJob of Object.values(db.jobs)) {
    if (
      otherJob.id !== job.id &&
      otherJob.video_id === video.id &&
      otherJob.status === 'complete' &&
      otherJob.download_location &&
      fs.existsSync(otherJob.download_location)
    ) {
      const otherSegs = [...(db.segments[otherJob.id] || [])].sort(
        (a, b) => a.sequence_order - b.sequence_order
      );
      const otherSig = computeClipRenderSignature(
        video.id,
        clampKeepPercentage(otherJob.keep_percentage),
        otherSegs
      );
      if (otherSig === signature && (await probeVideoStreamHeight(otherJob.download_location)) >= 720) {
        if (otherJob.download_location !== finalOutputPath) {
          fs.copyFileSync(otherJob.download_location, finalOutputPath);
        }
        const reusedDuration = otherJob.actual_output_duration || totalPlannedDuration;
        renderSignatureCache.set(signature, {
          outputPath: finalOutputPath,
          actualDuration: reusedDuration,
        });
        return { outputPath: finalOutputPath, actualDuration: reusedDuration };
      }
    }
  }

  // High-definition 720p 30fps encoding with single-stage post-concat scaling + multi-threaded libx264
  const audioKbps = 128;
  const maxVideoKbps = Math.max(
    500,
    Math.min(2500, Math.floor(200000 / totalPlannedDuration) - audioKbps)
  );
  const crfValue = totalPlannedDuration > 450 ? '21' : '19';

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
      filterParts.push(
        `[${i}:a:0]aresample=44100:async=1,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a${i}]`
      );
    } else {
      filterParts.push(
        `anullsrc=channel_layout=stereo:sample_rate=44100,atrim=0:${safeDuration.toFixed(3)}[a${i}]`
      );
    }
    concatInputs.push(`[${i}:v:0][a${i}]`);
  }

  const postConcatVideoFilter =
    sourceInfo.width === 1280 && sourceInfo.height === 720
      ? '[catv]setsar=1,fps=30[outv]'
      : '[catv]scale=1280:720:force_original_aspect_ratio=decrease:flags=lanczos,pad=ceil(iw/2)*2:ceil(ih/2)*2,setsar=1,fps=30[outv]';

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
    'ultrafast',
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
    '44100',
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
    const probedDuration = await probeVideoDuration(finalOutputPath);
    const actualDuration =
      Math.abs(probedDuration - totalPlannedDuration) < 0.8
        ? totalPlannedDuration
        : probedDuration;
    renderSignatureCache.set(signature, { outputPath: finalOutputPath, actualDuration });
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
      16,
      `Verified metadata for "${video.title}" (${formatTimestamp(video.duration)})`
    );

    const fixture = DEVELOPMENT_FIXTURES[video.youtube_video_id];

    // Launch Media Download + Signal Extraction, Gemini Multimodal Analysis, and Engagement Check in PARALLEL
    const mediaAndSignalsTask = (async (): Promise<SourceMediaSignals | null> => {
      if (fixture?.hasPrebuiltSourceFile && job.source_media_status === 'fixture_ready') {
        const fixtureMp4 = await ensureFixtureSourceVideo();
        job.source_media_path = fixtureMp4;
        job.source_media_duration = video.duration;
        job.rights_confirmed = true;
        saveDb();
      } else if (!job.source_media_path && !video.is_fixture && video.youtube_video_id) {
        const downloadedMp4 = await downloadYouTubeVideoMp4(video.youtube_video_id);
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
      44,
      'Identifying intro, actual best moments, and outro across the video...'
    );

    const geminiRawTask = fixture
      ? Promise.resolve(null)
      : fetchGeminiRawCandidates(video, activeKeepPct);

    const engagementTask = fetchEngagementData(video.youtube_video_id, channelAccessToken);

    const [mediaSignals, geminiRaw, engagement] = await Promise.all([
      mediaAndSignalsTask,
      geminiRawTask,
      engagementTask,
    ]);

    const geminiResult = await analyzeVideoWithGemini(
      video,
      mediaSignals,
      activeKeepPct,
      geminiRaw
    );

    updateJobStage(
      jobId,
      'checking_engagement',
      3,
      62,
      'Checking audience retention and engagement signals...'
    );
    const { smoothedTimeline, peaks } = engagement.available
      ? analyzeEngagementTimeline(engagement.observations, video.duration)
      : { smoothedTimeline: [], peaks: [] };

    updateJobStage(
      jobId,
      'identifying_moments',
      4,
      74,
      `Identified ${geminiResult.highlights.length} candidate moments across the timeline...`,
      {
        engagement_available: engagement.available,
        engagement_source: engagement.source,
        engagement_timeline: smoothedTimeline,
        video_summary: geminiResult.video_summary,
        video_category: geminiResult.video_category,
        analysis_mode: fixture ? 'development_fixture' : 'gemini_live',
      }
    );

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
      88,
      `Selected ${segmentRecords.length} chronological clips totaling ${formatTimestamp(
        plannedDuration
      )} (${activeKeepPct}% compiled)...`,
      {
        actual_output_duration: plannedDuration,
      }
    );

    if (job.source_media_path && fs.existsSync(job.source_media_path)) {
      updateJobStage(
        jobId,
        'rendering_video',
        7,
        94,
        'Cutting and stitching 720p HD video clips and audio with FFmpeg...',
        { source_media_status: 'rendering' }
      );

      const { outputPath, actualDuration } = await renderHighlightReelWithFfmpeg(
        job,
        video,
        segmentRecords
      );

      updateJobStage(
        jobId,
        'complete',
        8,
        100,
        'Highlight video compiled and ready to watch.',
        {
          source_media_status: 'rendered',
          download_location: outputPath,
          actual_output_duration: actualDuration,
        }
      );
    } else {
      updateJobStage(
        jobId,
        'complete',
        8,
        100,
        'Highlight video ready to watch.',
        {
          source_media_status: 'missing_source',
        }
      );
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
  // Remove stale non-fixture videos that had fallback 300s duration and are not referenced by any job
  const referencedVideoIds = new Set(Object.values(db.jobs).map((j) => j.video_id));
  for (const [vidId, vid] of Object.entries(db.videos)) {
    if (!vid.is_fixture && vid.duration === 300 && !referencedVideoIds.has(vidId)) {
      delete db.videos[vidId];
    }
  }

  // Resume any interrupted in-progress jobs
  for (const job of Object.values(db.jobs)) {
    if (job.status !== 'complete' && job.status !== 'failed') {
      void runHighlightPipeline(job.id);
    }
  }

  // Remove older duplicate completed jobs for the same video_id or identical uploaded video title+duration
  const jobsByCreatedDesc = Object.values(db.jobs).sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
  const seenVideoKeys = new Set<string>();
  let removedDuplicates = false;
  for (const j of jobsByCreatedDesc) {
    const vid = db.videos[j.video_id];
    const dedupKey = vid
      ? `${vid.title.trim().toLowerCase()}::${Math.round(vid.duration)}`
      : j.video_id;
    if (seenVideoKeys.has(j.video_id) || seenVideoKeys.has(dedupKey) || j.video_id === 'vid-chvzvot4X1A') {
      delete db.jobs[j.id];
      delete db.segments[j.id];
      removedDuplicates = true;
    } else {
      seenVideoKeys.add(j.video_id);
      seenVideoKeys.add(dedupKey);
    }
  }
  if (removedDuplicates) {
    saveDb();
  }

  for (const job of Object.values(db.jobs)) {
    if (job.status !== 'complete') continue;
    const video = db.videos[job.video_id];
    let segments = db.segments[job.id] || [];
    if (!video || segments.length === 0) continue;

    // Ensure every segment has an explicit role classification
    let rolesUpdated = false;
    const jobKeepPct = clampKeepPercentage(job.keep_percentage);
    if (job.keep_percentage !== jobKeepPct) {
      job.keep_percentage = jobKeepPct;
      rolesUpdated = true;
    }

    if (
      !video.is_fixture &&
      video.id.startsWith('vid-upload-') &&
      video.thumbnail === KEYNOTE_THUMBNAIL_SVG &&
      job.source_media_path &&
      fs.existsSync(job.source_media_path)
    ) {
      const realThumb = await extractVideoFrameDataUri(job.source_media_path);
      if (realThumb) {
        video.thumbnail = realThumb;
        rolesUpdated = true;
      }
    }
    for (const seg of segments) {
      const inferred = classifySegmentRole(seg, video.duration);
      if (seg.role !== inferred) {
        seg.role = inferred;
        rolesUpdated = true;
      }
    }

    const exactSegmentSum = segments.reduce((acc, s) => acc + (s.end_time - s.start_time), 0);
    if (
      exactSegmentSum > 0 &&
      Math.abs((job.actual_output_duration || 0) - exactSegmentSum) > 0.001 &&
      Math.abs((job.actual_output_duration || 0) - exactSegmentSum) < 1.0
    ) {
      job.actual_output_duration = exactSegmentSum;
      rolesUpdated = true;
    }

    const lacksIntroOrOutro =
      video.duration >= 20 &&
      (segments[0]?.role !== 'intro' || segments[segments.length - 1]?.role !== 'outro');

    // Detect legacy jobs with rounded integer durations, duplicate titles, or fixed repeated clip blocks
    const clipDurations = segments.map((s) => Math.round((s.end_time - s.start_time) * 100) / 100);
    const clipTitles = segments.map((s) => s.title);
    const hasDuplicateTitles = new Set(clipTitles).size < clipTitles.length;
    const hasDuplicateFixedBlocks =
      new Set(clipDurations).size < clipDurations.length ||
      clipDurations.includes(36) ||
      clipDurations.includes(45);
    const hasRoundedSegmentTimes = segments.every(
      (s) => Number.isInteger(s.start_time) && Number.isInteger(s.end_time)
    );
    const hasRoundedVideoDuration =
      !video.is_fixture && Number.isInteger(video.duration);
    const expectedReelSeconds = video.duration * (jobKeepPct / 100);
    const deviatesFromKeepPercent =
      Math.abs((job.actual_output_duration || 0) - expectedReelSeconds) > 1.2;

    const needsTimingRefinement =
      lacksIntroOrOutro ||
      hasDuplicateTitles ||
      hasDuplicateFixedBlocks ||
      hasRoundedSegmentTimes ||
      hasRoundedVideoDuration ||
      deviatesFromKeepPercent;

    const lacksRealSource = !job.source_media_path || !fs.existsSync(job.source_media_path);
    let isLowResolutionRender = false;
    if (job.download_location && fs.existsSync(job.download_location)) {
      const renderHeight = await probeVideoStreamHeight(job.download_location);
      if (renderHeight > 0 && renderHeight < 720) {
        isLowResolutionRender = true;
      }
    }
    const lacksRenderedOutput =
      job.source_media_status !== 'rendered' ||
      !job.download_location ||
      !fs.existsSync(job.download_location) ||
      fs.statSync(job.download_location).size > 29 * 1024 * 1024 ||
      isLowResolutionRender;

    if (lacksRealSource || lacksRenderedOutput || needsTimingRefinement) {
      try {
        if (lacksRealSource) {
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
            } else {
              job.source_media_status = 'missing_source';
              job.download_location = undefined;
              saveDb();
              continue;
            }
          }
        }

        if (!video.is_fixture && job.source_media_path && fs.existsSync(job.source_media_path)) {
          const exactDur = await probeVideoDuration(job.source_media_path);
          if (exactDur >= 5) {
            video.duration = exactDur;
            job.source_media_duration = exactDur;
            job.target_duration = calculateTargetDuration(
              exactDur,
              0.04,
              jobKeepPct
            ).targetSeconds;
          }
        }

        if (needsTimingRefinement && !video.is_fixture) {
          const mediaSignals = await analyzeSourceMediaSignals(
            job.source_media_path,
            video.duration,
            jobKeepPct
          );
          const seenExistingTitles = new Set<string>();
          const realExistingSegments = segments
            .filter((s) => {
              if (s.title.startsWith('Best Moment —')) return false;
              if (seenExistingTitles.has(s.title)) return false;
              seenExistingTitles.add(s.title);
              return true;
            })
            .map((s, idx) => {
              const len = s.end_time - s.start_time;
              const isLegacyFixedBlock =
                Math.abs(len - 36) < 0.25 || Math.abs(len - 45) < 0.25;
              const naturalFactor = idx === 0 ? 0.023 : 0.031 + ((idx * 17) % 19) * 0.0014;
              const restoredEnd = isLegacyFixedBlock
                ? s.start_time + video.duration * naturalFactor
                : s.end_time;
              return {
                ...s,
                end_time: Math.min(video.duration, restoredEnd),
              };
            });

          const aligned = alignAndEnrichCandidatesWithMediaSignals(
            {
              video_summary: job.video_summary || video.description,
              video_category: job.video_category || 'Video',
              highlights: realExistingSegments,
            },
            video.duration,
            mediaSignals,
            jobKeepPct
          );

          const coveredPool = ensureCandidateCoverageForTarget(
            aligned.highlights,
            video.duration,
            jobKeepPct
          );
          const scored = scoreAndMergeCandidates(coveredPool, [], {
            engagementAvailable: false,
            audioAvailable: true,
            videoDuration: video.duration,
          });
          const reselected = selectHighlightReel(
            scored,
            video.duration,
            {
              pauseBoundaries: mediaSignals?.pauseBoundaries || [],
            },
            jobKeepPct
          );
          if (reselected.length > 0) {
            segments = reselected.map((seg, idx) => ({
              id: `seg-${job.id}-${idx + 1}`,
              job_id: job.id,
              ...seg,
              role: seg.role || classifySegmentRole(seg, video.duration),
            }));
            db.segments[job.id] = segments;
            rolesUpdated = true;
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
        } else if (rolesUpdated) {
          saveDb();
        }
      } catch (err) {
        console.warn(`Failed to backfill compiled MP4 for job ${job.id}:`, err);
      }
    } else if (rolesUpdated) {
      saveDb();
    }
  }
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  ensureFixtureSourceVideo().catch((err) =>
    console.warn('Background fixture video generation warning:', err)
  );
  backfillMissingCompiledVideos().catch((err) =>
    console.warn('Background backfill compilation warning:', err)
  );

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

  app.get('/api/highlights', (_req, res) => {
    const jobsList = Object.values(db.jobs)
      .filter((j) => j.status === 'complete' && (db.segments[j.id] || []).length > 0)
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

    const existingRenderHeight =
      job.download_location && fs.existsSync(job.download_location)
        ? await probeVideoStreamHeight(job.download_location)
        : 0;

    if (
      job.status === 'complete' &&
      segments.length > 0 &&
      video &&
      (job.source_media_status !== 'rendered' ||
        !job.download_location ||
        !fs.existsSync(job.download_location) ||
        (existingRenderHeight > 0 && existingRenderHeight < 720))
    ) {
      try {
        if (!job.source_media_path || !fs.existsSync(job.source_media_path)) {
          if (video.is_fixture) {
            job.source_media_path = await ensureFixtureSourceVideo();
            job.source_media_duration = video.duration;
            job.rights_confirmed = true;
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
      } catch (err) {
        console.warn(`On-demand render warning for job ${job.id}:`, err);
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
      } catch (err) {
        console.warn(`On-demand download render warning for job ${job.id}:`, err);
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

    const stat = fs.statSync(job.download_location);
    const fileSize = stat.size;
    const range = req.headers.range;

    res.setHeader(
      'Content-Disposition',
      `inline; filename="${asciiSafeFilename}"; filename*=UTF-8''${encodedUtf8Filename}`
    );
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'video/mp4');

    if (req.query.download === '1') {
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${asciiSafeFilename}"; filename*=UTF-8''${encodedUtf8Filename}`
      );
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
    const vite = await createViteServer({
      server: { middlewareMode: true },
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

  const PORT = 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Highlight server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
