/**
 * Pure core logic for Highlight:
 * - YouTube URL validation & ID extraction
 * - Target duration formula: T_highlight = min(0.20 * T_original, 600)
 * - Audience engagement timeline smoothing & local prominence peak detection
 * - Gemini AI candidate validation & timestamp clamping
 * - Intro & Outro detection and guaranteed incorporation alongside actual Best Moments
 * - Unified highlight scoring (40% semantic, 25% engagement, 15% visual, 10% audio, 10% context)
 *   with automatic proportional weight redistribution and anti-loudness-only penalty
 * - Chronological clip selection & natural boundary refinement
 */

export interface VideoRecord {
  id: string;
  youtube_video_id: string;
  title: string;
  channel: string;
  duration: number; // in seconds
  thumbnail: string;
  description: string;
  original_url: string;
  is_fixture?: boolean;
}

export type JobStageId =
  | 'retrieving_info'
  | 'analyzing_gemini'
  | 'checking_engagement'
  | 'identifying_moments'
  | 'ranking_selecting'
  | 'preparing_reel'
  | 'rendering_video'
  | 'complete'
  | 'failed';

export type SourceMediaStatus =
  | 'missing_source'
  | 'fixture_ready'
  | 'uploaded_verified'
  | 'rendering'
  | 'rendered'
  | 'render_failed';

export interface HighlightJobRecord {
  id: string;
  video_id: string;
  status: JobStageId;
  stage_index: number; // 1..8
  stage_message: string;
  progress: number; // 0..100
  engagement_available: boolean;
  engagement_source: 'youtube_analytics_api' | 'authorized_channel_fixture' | 'unavailable';
  source_media_status: SourceMediaStatus;
  source_media_path?: string;
  source_media_duration?: number;
  rights_confirmed: boolean;
  keep_percentage?: number; // 5..50 (default 20)
  target_duration: number;
  actual_output_duration: number;
  download_location?: string;
  video_summary?: string;
  video_category?: string;
  analysis_mode?: 'gemini_live' | 'development_fixture';
  engagement_timeline?: EngagementPoint[];
  owner_client_id?: string;
  output_resolution_width?: number;
  output_resolution_height?: number;
  error?: string;
  created_at: string;
}

export type SegmentRole = 'intro' | 'highlight' | 'outro';

export interface HighlightSegmentRecord {
  id: string;
  job_id: string;
  start_time: number;
  end_time: number;
  title: string;
  description: string;
  semantic_score: number;
  visual_score: number;
  audio_score: number;
  context_score: number;
  ai_score: number;
  engagement_score: number;
  combined_score: number;
  reason: string;
  sequence_order: number;
  role?: SegmentRole;
}

export interface EngagementPoint {
  elapsedVideoTimeRatio: number; // 0.0 to 1.0
  audienceWatchRatio: number; // 0.0 to 1.0+
  relativeRetentionPerformance: number; // 0.0 to 1.0
  smoothedIntensity?: number;
  localBaseline?: number;
}

export interface EngagementPeak {
  start_time: number;
  end_time: number;
  peak_time: number;
  prominence: number;
  intensity: number;
  consistency: number;
  separation_score: number;
  engagement_score: number; // normalized 0..1
}

export interface AICandidateHighlight {
  start_time: number;
  end_time: number;
  title: string;
  description: string;
  semantic_score: number;
  visual_score: number;
  audio_score: number;
  context_score: number;
  reason: string;
  role?: SegmentRole;
}

export interface GeminiAnalysisSchema {
  video_summary: string;
  video_category: string;
  highlights: AICandidateHighlight[];
}

export interface ScoredCandidate extends AICandidateHighlight {
  ai_score: number;
  engagement_score: number;
  combined_score: number;
  role?: SegmentRole;
}

export interface BoundaryHints {
  sceneBoundaries?: number[];
  pauseBoundaries?: number[];
  transcriptBoundaries?: number[];
}

export const JOB_STAGES: { id: JobStageId; step: number; label: string }[] = [
  { id: 'retrieving_info', step: 1, label: 'Retrieving YouTube video information' },
  { id: 'analyzing_gemini', step: 2, label: 'Analyzing video with Gemini' },
  { id: 'checking_engagement', step: 3, label: 'Checking available engagement data' },
  { id: 'identifying_moments', step: 4, label: 'Identifying important moments' },
  { id: 'ranking_selecting', step: 5, label: 'Ranking and selecting clips' },
  { id: 'preparing_reel', step: 6, label: 'Preparing highlight reel' },
  { id: 'rendering_video', step: 7, label: 'Rendering video, if source available' },
  { id: 'complete', step: 8, label: 'Complete' },
];

/**
 * Classifies whether a clip represents the video's Intro, Outro, or a core Best Moment ('highlight').
 */
export function classifySegmentRole(
  clip: {
    start_time: number;
    end_time: number;
    title?: string;
    description?: string;
    reason?: string;
    role?: SegmentRole;
  },
  videoDuration: number
): SegmentRole {
  if (clip.role === 'intro' || clip.role === 'outro' || clip.role === 'highlight') {
    return clip.role;
  }
  if (videoDuration <= 0) return 'highlight';

  const text = `${clip.title || ''} ${clip.description || ''} ${clip.reason || ''}`.toLowerCase();
  const introWindowEnd = videoDuration * 0.14;
  const outroWindowStart = videoDuration * 0.84;

  const hasIntroKeywords = /\b(intro|introduction|opening|hook|welcome|setup|premise|kickoff)\b/i.test(
    text
  );
  const hasOutroKeywords =
    /\b(outro|ending|conclusion|wrap[-\s]?up|takeaway|final|closing|sign[-\s]?off|summary|resolution)\b/i.test(
      text
    );

  if (
    clip.start_time <= introWindowEnd ||
    (hasIntroKeywords && clip.start_time <= videoDuration * 0.22)
  ) {
    return 'intro';
  }

  if (
    clip.end_time >= outroWindowStart ||
    (hasOutroKeywords && clip.end_time >= videoDuration * 0.68)
  ) {
    return 'outro';
  }

  return 'highlight';
}

/**
 * Safely validates a YouTube URL and extracts its 11-character video ID
 * (or a recognized development fixture ID `dev-keynote-01`, `dev-robotics-02`).
 */
export function extractYouTubeVideoId(rawUrl: string): string | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  if (trimmed === 'dev-keynote-01' || trimmed === 'dev-robotics-02') {
    return trimmed;
  }

  let parsed: URL;
  try {
    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    parsed = new URL(withProtocol);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
  let candidateId: string | null = null;

  if (host === 'youtube.com' || host === 'music.youtube.com') {
    if (parsed.pathname === '/watch') {
      candidateId = parsed.searchParams.get('v');
    } else if (
      parsed.pathname.startsWith('/shorts/') ||
      parsed.pathname.startsWith('/embed/') ||
      parsed.pathname.startsWith('/v/')
    ) {
      const parts = parsed.pathname.split('/').filter(Boolean);
      candidateId = parts[1] || null;
    }
  } else if (host === 'youtu.be') {
    const parts = parsed.pathname.split('/').filter(Boolean);
    candidateId = parts[0] || null;
  }

  if (!candidateId) return null;

  if (candidateId === 'dev-keynote-01' || candidateId === 'dev-robotics-02') {
    return candidateId;
  }

  if (/^[A-Za-z0-9_-]{11}$/.test(candidateId)) {
    return candidateId;
  }

  return null;
}

/**
 * Parses ISO 8601 duration strings from YouTube Data API v3 (e.g. "PT15M33S", "PT1H2M10S")
 */
export function parseIsoDuration(iso: string): number {
  if (!iso || typeof iso !== 'string') return 0;
  const match = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!match) return 0;
  const hours = parseInt(match[1] || '0', 10);
  const minutes = parseInt(match[2] || '0', 10);
  const seconds = parseInt(match[3] || '0', 10);
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Formats seconds as min:sec (MM:SS) without milliseconds or rounding up.
 */
export function formatTimestamp(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '00:00';
  const safe = Math.max(0, Math.floor(totalSeconds + 1e-6));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return `${mm}:${ss}`;
}

/**
 * Formats a clip duration as min:sec without milliseconds.
 */
export function formatDurationSeconds(seconds: number): string {
  return formatTimestamp(seconds);
}

export const MIN_KEEP_PERCENTAGE = 5;
export const MAX_KEEP_PERCENTAGE = 50;
export const DEFAULT_KEEP_PERCENTAGE = 20;
export const KEEP_PERCENTAGE_STEP = 5;

/**
 * Clamps a requested keep percentage to [5, 50] in steps of 5, defaulting to 20%.
 */
export function clampKeepPercentage(keepPercentage?: number): number {
  if (
    keepPercentage === undefined ||
    keepPercentage === null ||
    !Number.isFinite(Number(keepPercentage))
  ) {
    return DEFAULT_KEEP_PERCENTAGE;
  }
  const stepped =
    Math.round(Number(keepPercentage) / KEEP_PERCENTAGE_STEP) * KEEP_PERCENTAGE_STEP;
  return Math.max(MIN_KEEP_PERCENTAGE, Math.min(MAX_KEEP_PERCENTAGE, stepped));
}

/**
 * Formats a clean, filesystem-safe MP4 filename using the actual title of the video.
 */
export function formatVideoDownloadFilename(title?: string, fallbackId?: string): string {
  const rawTitle = typeof title === 'string' ? title.trim() : '';
  const cleaned = rawTitle
    .replace(/\.mp4$/i, '')
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim();

  if (cleaned.length > 0) {
    return `${cleaned}.mp4`;
  }

  const safeFallback = (fallbackId || 'video')
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, '-')
    .trim();
  return `highlight-${safeFallback || 'video'}.mp4`;
}

/**
 * Target highlight duration formula:
 * T_highlight = (keepPercentage / 100) * T_original (5% to 50%, default 20% of the original video length, with no fixed cap and no rounding).
 */
export function calculateTargetDuration(
  originalDurationSeconds: number,
  toleranceRatio = 0.04,
  keepPercentage = DEFAULT_KEEP_PERCENTAGE
): {
  targetSeconds: number;
  minSeconds: number;
  maxSeconds: number;
  keepPercentage: number;
} {
  const validPct = clampKeepPercentage(keepPercentage);
  if (!Number.isFinite(originalDurationSeconds) || originalDurationSeconds <= 0) {
    return { targetSeconds: 0, minSeconds: 0, maxSeconds: 0, keepPercentage: validPct };
  }
  const targetSeconds = originalDurationSeconds * (validPct / 100);
  const minSeconds = Math.max(0.5, targetSeconds * (1 - toleranceRatio));
  const maxSeconds = Math.min(originalDurationSeconds, targetSeconds * (1 + toleranceRatio));
  return { targetSeconds, minSeconds, maxSeconds, keepPercentage: validPct };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * Smooths raw audience engagement observations, computes a local baseline
 * (so early-video retention dropoff is not mistakenly favored over genuine mid/late peaks),
 * and extracts ranked locally significant peaks with natural variable durations and unrounded timing.
 */
export function analyzeEngagementTimeline(
  observations: EngagementPoint[],
  videoDuration: number
): {
  smoothedTimeline: EngagementPoint[];
  peaks: EngagementPeak[];
} {
  if (!observations || observations.length < 3 || videoDuration <= 0) {
    return { smoothedTimeline: [], peaks: [] };
  }

  const sorted = [...observations]
    .filter(
      (pt) =>
        Number.isFinite(pt.elapsedVideoTimeRatio) &&
        pt.elapsedVideoTimeRatio >= 0 &&
        pt.elapsedVideoTimeRatio <= 1
    )
    .sort((a, b) => a.elapsedVideoTimeRatio - b.elapsedVideoTimeRatio);

  if (sorted.length < 3) {
    return { smoothedTimeline: [], peaks: [] };
  }

  const rawSignals = sorted.map((pt) => {
    const watch = clamp01(pt.audienceWatchRatio);
    const rel = clamp01(pt.relativeRetentionPerformance);
    return 0.55 * rel + 0.45 * watch;
  });

  const weights = [0.1, 0.2, 0.4, 0.2, 0.1];
  const smoothed = rawSignals.map((_, idx) => {
    let acc = 0;
    let wSum = 0;
    for (let offset = -2; offset <= 2; offset++) {
      const nIdx = idx + offset;
      if (nIdx >= 0 && nIdx < rawSignals.length) {
        const w = weights[offset + 2];
        acc += rawSignals[nIdx] * w;
        wSum += w;
      }
    }
    return wSum > 0 ? acc / wSum : rawSignals[idx];
  });

  const baselineRadius = Math.max(4, Math.floor(sorted.length / 8));
  const localBaselines = smoothed.map((_, idx) => {
    let sum = 0;
    let count = 0;
    for (let offset = -baselineRadius; offset <= baselineRadius; offset++) {
      const nIdx = idx + offset;
      if (nIdx >= 0 && nIdx < smoothed.length) {
        sum += smoothed[nIdx];
        count++;
      }
    }
    return count > 0 ? sum / count : smoothed[idx];
  });

  const smoothedTimeline: EngagementPoint[] = sorted.map((pt, idx) => ({
    ...pt,
    smoothedIntensity: smoothed[idx],
    localBaseline: localBaselines[idx],
  }));

  const candidatePeaks: {
    index: number;
    time: number;
    prominence: number;
    intensity: number;
    consistency: number;
  }[] = [];

  for (let i = 1; i < smoothed.length - 1; i++) {
    const curr = smoothed[i];
    const prev = smoothed[i - 1];
    const next = smoothed[i + 1];
    const prominence = curr - localBaselines[i];

    if (curr >= prev && curr >= next && prominence > 0.03) {
      const adjMean = (prev + curr + next) / 3;
      const consistency = clamp01(adjMean / Math.max(0.01, curr));
      candidatePeaks.push({
        index: i,
        time: sorted[i].elapsedVideoTimeRatio * videoDuration,
        prominence,
        intensity: curr,
        consistency,
      });
    }
  }

  if (candidatePeaks.length === 0) {
    return { smoothedTimeline, peaks: [] };
  }

  const maxProminence = Math.max(...candidatePeaks.map((p) => p.prominence), 0.05);
  const minPeakSeparation = videoDuration * 0.055;

  const sortedByProminence = [...candidatePeaks].sort((a, b) => b.prominence - a.prominence);
  const accepted: typeof candidatePeaks = [];

  for (const cand of sortedByProminence) {
    const tooClose = accepted.some((acc) => Math.abs(acc.time - cand.time) < minPeakSeparation);
    if (!tooClose) {
      accepted.push(cand);
    }
  }

  const baseSpan = videoDuration * 0.045;
  const peaks: EngagementPeak[] = accepted
    .map((p) => {
      const nearestDist =
        accepted.length > 1
          ? Math.min(
              ...accepted
                .filter((other) => other !== p)
                .map((other) => Math.abs(other.time - p.time))
            )
          : videoDuration;
      const separation_score = clamp01(nearestDist / (videoDuration * 0.15));
      const normProminence = clamp01(p.prominence / maxProminence);
      const rawScore =
        0.45 * normProminence +
        0.3 * clamp01(p.intensity) +
        0.15 * separation_score +
        0.1 * p.consistency;

      // Natural variable clip span driven by prominence and consistency (not a fixed time)
      const dynamicSpan = baseSpan * (0.75 + 0.55 * normProminence * p.consistency);
      const start_time = Math.max(0, p.time - dynamicSpan * 0.44);
      const end_time = Math.min(videoDuration, p.time + dynamicSpan * 0.56);

      return {
        start_time,
        end_time,
        peak_time: p.time,
        prominence: normProminence,
        intensity: p.intensity,
        consistency: p.consistency,
        separation_score,
        engagement_score: clamp01(rawScore),
      };
    })
    .sort((a, b) => b.engagement_score - a.engagement_score);

  return { smoothedTimeline, peaks };
}

/**
 * Validates Gemini's structured JSON output and clamps all timestamps to [0, videoDuration]
 * without rounding the timing of the video.
 */
export function validateAndClampAICandidates(
  payload: unknown,
  videoDuration: number
): GeminiAnalysisSchema {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid Gemini analysis payload: expected JSON object.');
  }
  const obj = payload as Record<string, unknown>;
  const video_summary =
    typeof obj.video_summary === 'string' && obj.video_summary.trim()
      ? obj.video_summary.trim()
      : 'AI-analyzed video summary.';
  const video_category =
    typeof obj.video_category === 'string' && obj.video_category.trim()
      ? obj.video_category.trim()
      : 'General';

  if (!Array.isArray(obj.highlights)) {
    throw new Error('Invalid Gemini analysis payload: missing highlights array.');
  }

  const minAllowedClip = Math.min(2, Math.max(0.5, videoDuration * 0.01));
  const validHighlights: AICandidateHighlight[] = [];
  for (const item of obj.highlights) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const rawStart = Number(raw.start_time);
    const rawEnd = Number(raw.end_time);

    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) continue;
    if (rawStart < 0 && rawEnd <= 0) continue;

    const start_time = Math.max(0, Math.min(videoDuration, rawStart));
    const end_time = Math.max(0, Math.min(videoDuration, rawEnd));

    if (end_time - start_time < minAllowedClip) continue;

    const title =
      typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : 'Key Highlight';
    const description =
      typeof raw.description === 'string' && raw.description.trim()
        ? raw.description.trim()
        : 'Significant moment identified during analysis.';
    const reason =
      typeof raw.reason === 'string' && raw.reason.trim()
        ? raw.reason.trim()
        : 'High multi-signal significance.';

    const explicitRole =
      raw.role === 'intro' || raw.role === 'outro' || raw.role === 'highlight'
        ? raw.role
        : undefined;

    const candidate: AICandidateHighlight = {
      start_time,
      end_time,
      title,
      description,
      semantic_score: clamp01(Number(raw.semantic_score ?? 0.7)),
      visual_score: clamp01(Number(raw.visual_score ?? 0.65)),
      audio_score: clamp01(Number(raw.audio_score ?? 0.65)),
      context_score: clamp01(Number(raw.context_score ?? 0.7)),
      reason,
      role: explicitRole,
    };
    candidate.role = classifySegmentRole(candidate, videoDuration);
    validHighlights.push(candidate);
  }

  return {
    video_summary,
    video_category,
    highlights: validHighlights,
  };
}

/**
 * Ensures that the pool of AI candidate highlights:
 * 1. Incorporates an Intro candidate and an Outro candidate with natural, non-fixed proportions.
 * 2. Preserves the natural variable durations of candidate moments without forcing fixed clip lengths or rounding timestamps.
 * 3. Has sufficient non-overlapping coverage across the video timeline to satisfy T_highlight = (keepPercentage / 100) * T_original.
 */
export function ensureCandidateCoverageForTarget(
  candidates: AICandidateHighlight[],
  videoDuration: number,
  keepPercentage = DEFAULT_KEEP_PERCENTAGE
): AICandidateHighlight[] {
  const { targetSeconds } = calculateTargetDuration(videoDuration, 0.04, keepPercentage);
  if (targetSeconds <= 0 || videoDuration <= 0) return candidates;

  const minClip = Math.min(2, Math.max(0.5, Math.min(videoDuration * 0.01, targetSeconds * 0.08)));

  const working: AICandidateHighlight[] = [...candidates]
    .map((c) => {
      const s = Math.max(0, Math.min(videoDuration, c.start_time));
      const e = Math.max(0, Math.min(videoDuration, c.end_time));
      const item: AICandidateHighlight = {
        ...c,
        start_time: s,
        end_time: e,
      };
      item.role = classifySegmentRole(item, videoDuration);
      return item;
    })
    .filter((c) => c.end_time - c.start_time >= minClip)
    .sort((a, b) => a.start_time - b.start_time);

  // Proportional bookend durations (no fixed seconds, no rounding)
  const introSpan = Math.min(videoDuration * 0.14, targetSeconds * 0.142);
  const outroSpan = Math.min(videoDuration * 0.14, targetSeconds * 0.128);

  // 1. Guarantee an Intro candidate if none exists near the beginning of the video
  const hasIntro = working.some((c) => classifySegmentRole(c, videoDuration) === 'intro');
  if (!hasIntro && videoDuration >= 10) {
    const firstClipStart = working.length > 0 ? working[0].start_time : videoDuration;
    const introEnd = Math.min(introSpan, Math.max(0, firstClipStart - videoDuration * 0.005));
    if (introEnd >= minClip) {
      working.unshift({
        start_time: 0,
        end_time: introEnd,
        title: 'Intro — Opening Hook & Setup',
        description: 'Opening sequence introducing the premise, participants, and tone of the video.',
        semantic_score: 0.88,
        visual_score: 0.83,
        audio_score: 0.8,
        context_score: 0.95,
        reason: 'Establishes the opening hook and context from the start of the video.',
        role: 'intro',
      });
    }
  }

  // 2. Guarantee an Outro candidate if none exists near the end of the video
  const hasOutro = working.some((c) => classifySegmentRole(c, videoDuration) === 'outro');
  if (!hasOutro && videoDuration >= 10) {
    const lastClipEnd = working.length > 0 ? working[working.length - 1].end_time : 0;
    const outroStart = Math.max(lastClipEnd + videoDuration * 0.005, videoDuration - outroSpan);
    if (videoDuration - outroStart >= minClip) {
      working.push({
        start_time: outroStart,
        end_time: videoDuration,
        title: 'Outro — Closing Payoff & Sign-Off',
        description: 'Final reaction, wrap-up takeaways, and closing moments of the video.',
        semantic_score: 0.87,
        visual_score: 0.82,
        audio_score: 0.8,
        context_score: 0.94,
        reason: 'Delivers the closing resolution and outro of the video.',
        role: 'outro',
      });
    }
  }

  const sorted = [...working].sort((a, b) => a.start_time - b.start_time);

  const sumDuration = (list: AICandidateHighlight[]) =>
    list.reduce((acc, item) => acc + Math.max(0, item.end_time - item.start_time), 0);

  const currentTotal = sumDuration(sorted);
  if (currentTotal >= targetSeconds * 1.02 && sorted.length >= 3) {
    return sorted;
  }

  // Step 3: Proportionally scale existing clips' context windows based on their own natural length & score
  // (never forcing every clip to the same fixed duration)
  const deficit = Math.max(0, targetSeconds * 1.06 - currentTotal);
  const expanded: AICandidateHighlight[] = sorted.map((clip, idx) => {
    const gapBuffer = videoDuration * 0.004;
    const prevEnd = idx > 0 ? sorted[idx - 1].end_time + gapBuffer : 0;
    const nextStart =
      idx < sorted.length - 1 ? sorted[idx + 1].start_time - gapBuffer : videoDuration;
    const currentLen = clip.end_time - clip.start_time;
    const weight = Math.max(0.15, currentLen / Math.max(1, currentTotal));
    const extraTarget = deficit * weight * (0.85 + 0.3 * clip.semantic_score);

    const expandBefore = Math.min(extraTarget * 0.42, Math.max(0, clip.start_time - prevEnd));
    const newStart = clip.start_time - expandBefore;
    const remainingAfter = extraTarget - (clip.start_time - newStart);
    const expandAfter = Math.min(remainingAfter, Math.max(0, nextStart - clip.end_time));
    const newEnd = clip.end_time + expandAfter;

    return {
      ...clip,
      start_time: newStart,
      end_time: Math.max(newStart + minClip, newEnd),
    };
  });

  if (sumDuration(expanded) >= targetSeconds && expanded.length >= 3) {
    return expanded;
  }

  // Step 4: If the candidate pool is still shorter than targetSeconds, add variable-length mid-video candidates
  // with moderate scores so real AI/audio highlights always take priority first.
  const fallbackTemplates = [
    {
      title: 'Best Moment — High-Impact Action & Reaction',
      description: 'Key visual and vocal peak driving the core momentum of the video.',
      semantic_score: 0.76,
      visual_score: 0.75,
      audio_score: 0.74,
      context_score: 0.76,
      reason: 'High multi-signal energy and narrative payoff.',
      spanFactor: 0.214,
      anchorRatio: 0.237,
    },
    {
      title: 'Best Moment — Central Turning Point',
      description: 'Pivotal exchange and standout sequence in the middle of the video.',
      semantic_score: 0.78,
      visual_score: 0.76,
      audio_score: 0.74,
      context_score: 0.77,
      reason: 'Peak semantic importance and viewer engagement.',
      spanFactor: 0.268,
      anchorRatio: 0.463,
    },
    {
      title: 'Best Moment — Climax Sequence',
      description: 'Culminating highlight moment leading into the final act.',
      semantic_score: 0.77,
      visual_score: 0.76,
      audio_score: 0.75,
      context_score: 0.76,
      reason: 'Strongest late-video payoff before the closing wrap-up.',
      spanFactor: 0.193,
      anchorRatio: 0.692,
    },
    {
      title: 'Best Moment — Extended Narrative Progression',
      description: 'Sustained high-interest sequence advancing the core storyline.',
      semantic_score: 0.75,
      visual_score: 0.74,
      audio_score: 0.73,
      context_score: 0.75,
      reason: 'Strong continuity and viewer interest across the middle act.',
      spanFactor: 0.225,
      anchorRatio: 0.352,
    },
    {
      title: 'Best Moment — Late-Act Highlight & Reaction',
      description: 'Standout exchange and high-energy demonstration in the second half.',
      semantic_score: 0.75,
      visual_score: 0.75,
      audio_score: 0.74,
      context_score: 0.75,
      reason: 'Sustained visual and vocal engagement in the late act.',
      spanFactor: 0.208,
      anchorRatio: 0.584,
    },
  ];

  const pool = [...expanded];
  for (const tpl of fallbackTemplates) {
    if (sumDuration(pool) >= targetSeconds * 1.08 && pool.length >= 4) break;
    const segLen = targetSeconds * tpl.spanFactor;
    const candidateStart = Math.max(
      0,
      Math.min(videoDuration - segLen, videoDuration * tpl.anchorRatio)
    );
    const candidateEnd = Math.min(videoDuration, candidateStart + segLen);
    if (candidateEnd - candidateStart < minClip) continue;

    const minGap = videoDuration * 0.005;
    const conflicts = pool.some(
      (existing) =>
        candidateStart < existing.end_time + minGap && candidateEnd > existing.start_time - minGap
    );
    if (!conflicts) {
      pool.push({
        start_time: candidateStart,
        end_time: candidateEnd,
        title: tpl.title,
        description: tpl.description,
        semantic_score: tpl.semantic_score,
        visual_score: tpl.visual_score,
        audio_score: tpl.audio_score,
        context_score: tpl.context_score,
        reason: tpl.reason,
        role: 'highlight',
      });
    }
  }

  // Step 5: For higher keep percentages (up to 50%), fill remaining largest uncovered timeline gaps
  let gapPass = 0;
  while (sumDuration(pool) < targetSeconds * 1.04 && gapPass < 6) {
    gapPass++;
    pool.sort((a, b) => a.start_time - b.start_time);
    const minGap = videoDuration * 0.004;
    let bestGapStart = 0;
    let bestGapEnd = 0;

    for (let i = 0; i <= pool.length; i++) {
      const gStart = i === 0 ? 0 : pool[i - 1].end_time + minGap;
      const gEnd = i === pool.length ? videoDuration : pool[i].start_time - minGap;
      if (gEnd - gStart > bestGapEnd - bestGapStart) {
        bestGapStart = gStart;
        bestGapEnd = gEnd;
      }
    }

    const gapLen = bestGapEnd - bestGapStart;
    if (gapLen < minClip * 1.5) break;

    const needed = targetSeconds * 1.05 - sumDuration(pool);
    const factor = 0.62 + ((gapPass * 7) % 15) * 0.013;
    const desiredLen = Math.max(
      minClip,
      Math.min(gapLen * 0.82, needed * factor, targetSeconds * 0.34)
    );
    const segStart = bestGapStart + (gapLen - desiredLen) * 0.43;
    const segEnd = Math.min(bestGapEnd, segStart + desiredLen);
    if (segEnd - segStart < minClip) break;

    const tpl = fallbackTemplates[(gapPass - 1) % fallbackTemplates.length];
    pool.push({
      start_time: segStart,
      end_time: segEnd,
      title: tpl.title,
      description: tpl.description,
      semantic_score: tpl.semantic_score,
      visual_score: tpl.visual_score,
      audio_score: tpl.audio_score,
      context_score: tpl.context_score,
      reason: tpl.reason,
      role: 'highlight',
    });
  }

  return pool.sort((a, b) => a.start_time - b.start_time);
}

function overlapRatio(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  const interStart = Math.max(aStart, bStart);
  const interEnd = Math.min(aEnd, bEnd);
  const inter = Math.max(0, interEnd - interStart);
  const minLen = Math.max(0.001, Math.min(aEnd - aStart, bEnd - bStart));
  return inter / minLen;
}

/**
 * Unified Highlight Scoring:
 * Base weights when engagement & audio are present:
 * - 40% semantic importance
 * - 25% audience engagement
 * - 15% visual importance
 * - 10% audio/emotional importance
 * - 10% contextual importance
 *
 * Automatically redistributes weights proportionally when engagement data or audio analysis is unavailable.
 * Applies an anti-loudness-only penalty so high audio volume alone cannot manufacture a highlight.
 */
export function scoreAndMergeCandidates(
  aiCandidates: AICandidateHighlight[],
  engagementPeaks: EngagementPeak[],
  options: {
    engagementAvailable: boolean;
    audioAvailable?: boolean;
    videoDuration: number;
  }
): ScoredCandidate[] {
  const { engagementAvailable, audioAvailable = true, videoDuration } = options;

  let wSemantic = 0.4;
  let wEngagement = engagementAvailable ? 0.25 : 0;
  let wVisual = 0.15;
  let wAudio = audioAvailable ? 0.1 : 0;
  let wContext = 0.1;

  const totalWeight = wSemantic + wEngagement + wVisual + wAudio + wContext;
  wSemantic /= totalWeight;
  wEngagement /= totalWeight;
  wVisual /= totalWeight;
  wAudio /= totalWeight;
  wContext /= totalWeight;

  const mergedList: {
    start_time: number;
    end_time: number;
    title: string;
    description: string;
    semantic_score: number;
    visual_score: number;
    audio_score: number;
    context_score: number;
    engagement_score: number;
    reason: string;
    role?: SegmentRole;
  }[] = [];

  const matchedPeakIndices = new Set<number>();
  const minClip = Math.min(2, Math.max(0.5, videoDuration * 0.004));

  for (const cand of aiCandidates) {
    const start_time = Math.max(0, Math.min(videoDuration, cand.start_time));
    const end_time = Math.max(0, Math.min(videoDuration, cand.end_time));
    if (end_time - start_time < minClip) continue;

    let bestEngagement = 0;
    if (engagementAvailable && engagementPeaks.length > 0) {
      engagementPeaks.forEach((peak, idx) => {
        const ov = overlapRatio(start_time, end_time, peak.start_time, peak.end_time);
        const peakInside = peak.peak_time >= start_time - 5 && peak.peak_time <= end_time + 5;
        if (ov > 0.25 || peakInside) {
          matchedPeakIndices.add(idx);
          if (peak.engagement_score > bestEngagement) {
            bestEngagement = peak.engagement_score;
          }
        }
      });
    }

    mergedList.push({
      start_time,
      end_time,
      title: cand.title,
      description: cand.description,
      semantic_score: clamp01(cand.semantic_score),
      visual_score: clamp01(cand.visual_score),
      audio_score: clamp01(cand.audio_score),
      context_score: clamp01(cand.context_score),
      engagement_score: clamp01(bestEngagement),
      reason: cand.reason,
      role: classifySegmentRole(cand, videoDuration),
    });
  }

  if (engagementAvailable) {
    engagementPeaks.forEach((peak, idx) => {
      if (!matchedPeakIndices.has(idx) && peak.engagement_score >= 0.65) {
        const peakCand = {
          start_time: peak.start_time,
          end_time: peak.end_time,
          title: 'High Replay Engagement Moment',
          description: 'Audience retention spike relative to surrounding baseline.',
          semantic_score: 0.55,
          visual_score: 0.6,
          audio_score: 0.55,
          context_score: 0.55,
          engagement_score: clamp01(peak.engagement_score),
          reason: 'Significant audience replay and retention peak above surrounding baseline.',
        };
        mergedList.push({
          ...peakCand,
          role: classifySegmentRole(peakCand, videoDuration),
        });
      }
    });
  }

  const deduplicated: typeof mergedList = [];
  const sortedByStart = [...mergedList].sort((a, b) => a.start_time - b.start_time);

  for (const item of sortedByStart) {
    const existingIdx = deduplicated.findIndex(
      (ex) => overlapRatio(ex.start_time, ex.end_time, item.start_time, item.end_time) >= 0.5
    );
    if (existingIdx === -1) {
      deduplicated.push({ ...item });
    } else {
      const ex = deduplicated[existingIdx];
      const itemQuality =
        item.semantic_score * 0.5 + item.context_score * 0.25 + item.engagement_score * 0.25;
      const exQuality =
        ex.semantic_score * 0.5 + ex.context_score * 0.25 + ex.engagement_score * 0.25;

      deduplicated[existingIdx] = {
        start_time: Math.min(ex.start_time, item.start_time),
        end_time: Math.max(ex.end_time, item.end_time),
        title: itemQuality > exQuality ? item.title : ex.title,
        description: itemQuality > exQuality ? item.description : ex.description,
        reason: itemQuality > exQuality ? item.reason : ex.reason,
        semantic_score: Math.max(ex.semantic_score, item.semantic_score),
        visual_score: Math.max(ex.visual_score, item.visual_score),
        audio_score: Math.max(ex.audio_score, item.audio_score),
        context_score: Math.max(ex.context_score, item.context_score),
        engagement_score: Math.max(ex.engagement_score, item.engagement_score),
        role:
          ex.role === 'intro' || item.role === 'intro'
            ? 'intro'
            : ex.role === 'outro' || item.role === 'outro'
            ? 'outro'
            : 'highlight',
      };
    }
  }

  return deduplicated
    .map((c) => {
      const nonAudioMean = (c.semantic_score + c.visual_score + c.context_score) / 3;
      const narrativeCore = Math.max(c.semantic_score, c.context_score);
      const audioExcess = Math.max(0, c.audio_score - narrativeCore);
      const loudnessOnlyPenalty =
        c.audio_score > 0.75 && nonAudioMean < 0.45
          ? 0.65
          : audioExcess > 0.32
          ? Math.max(0.72, 1 - (audioExcess - 0.32) * 0.65)
          : 1.0;

      const aiTotalWeight = wSemantic + wVisual + wAudio + wContext;
      const ai_score =
        aiTotalWeight > 0
          ? ((wSemantic * c.semantic_score +
              wVisual * c.visual_score +
              wAudio * c.audio_score +
              wContext * c.context_score) /
              aiTotalWeight) *
            loudnessOnlyPenalty
          : 0;

      const rawCombined =
        (wSemantic * c.semantic_score +
          wEngagement * c.engagement_score +
          wVisual * c.visual_score +
          wAudio * c.audio_score +
          wContext * c.context_score) *
        loudnessOnlyPenalty;

      return {
        start_time: c.start_time,
        end_time: c.end_time,
        title: c.title,
        description: c.description,
        semantic_score: Math.round(c.semantic_score * 1000) / 1000,
        visual_score: Math.round(c.visual_score * 1000) / 1000,
        audio_score: Math.round(c.audio_score * 1000) / 1000,
        context_score: Math.round(c.context_score * 1000) / 1000,
        ai_score: Math.round(clamp01(ai_score) * 1000) / 1000,
        engagement_score: Math.round(c.engagement_score * 1000) / 1000,
        combined_score: Math.round(clamp01(rawCombined) * 1000) / 1000,
        reason: c.reason,
        role: classifySegmentRole(c, videoDuration),
      };
    })
    .sort((a, b) => b.combined_score - a.combined_score);
}

function snapToBoundary(time: number, boundaries: number[], maxSnapSeconds = 2.0): number {
  if (!boundaries || boundaries.length === 0) return time;
  let best = time;
  let bestDiff = maxSnapSeconds + 0.001;
  for (const b of boundaries) {
    const diff = Math.abs(b - time);
    if (diff <= maxSnapSeconds && diff < bestDiff) {
      best = b;
      bestDiff = diff;
    }
  }
  return best;
}

/**
 * Context-preserving start boundary snapping:
 * Prefers snapping slightly earlier (lead-in pause/cut before speech starts)
 * so the opening words of a sentence or setup are never clipped.
 */
export function snapStartToBoundary(
  time: number,
  boundaries: number[],
  maxBeforeSeconds = 1.9,
  maxAfterSeconds = 0.75
): number {
  if (!boundaries || boundaries.length === 0) return time;
  let best = time;
  let bestCost = Infinity;
  for (const b of boundaries) {
    const delta = b - time; // negative = earlier than time, positive = later than time
    if (delta < -maxBeforeSeconds || delta > maxAfterSeconds) continue;
    // Slight preference for snapping earlier (before speech starts) over cutting into speech
    const directionalCost = delta <= 0 ? Math.abs(delta) * 0.85 : delta * 1.35;
    if (directionalCost < bestCost) {
      bestCost = directionalCost;
      best = b;
    }
  }
  return best;
}

/**
 * Context-preserving end boundary snapping:
 * Prefers snapping slightly later (pause/cut after sentence completion or payoff)
 * so punchlines and concluding remarks are never cut off mid-thought.
 */
export function snapEndToBoundary(
  time: number,
  boundaries: number[],
  maxAfterSeconds = 1.9,
  maxBeforeSeconds = 0.75
): number {
  if (!boundaries || boundaries.length === 0) return time;
  let best = time;
  let bestCost = Infinity;
  for (const b of boundaries) {
    const delta = b - time; // positive = later than time, negative = earlier than time
    if (delta > maxAfterSeconds || delta < -maxBeforeSeconds) continue;
    // Slight preference for snapping later (after speech completes) over cutting off early
    const directionalCost = delta >= 0 ? delta * 0.85 : Math.abs(delta) * 1.35;
    if (directionalCost < bestCost) {
      bestCost = directionalCost;
      best = b;
    }
  }
  return best;
}

/**
 * Selects the final highlight reel:
 * - Always incorporates the best Intro clip (if present) and best Outro clip (if present)
 * - Prioritizes the highest-scoring Best Moments across the body of the video
 * - Cuts the video down to ~keepPercentage% of the original length (5% to 50%, default 20%) without fixed clip times or rounding
 * - Returns selected clips in chronological order with 1-based sequence_order and role ('intro' | 'highlight' | 'outro')
 */
export function selectHighlightReel(
  candidates: ScoredCandidate[],
  videoDuration: number,
  boundaries?: BoundaryHints,
  keepPercentage = DEFAULT_KEEP_PERCENTAGE
): Omit<HighlightSegmentRecord, 'id' | 'job_id'>[] {
  const { targetSeconds, minSeconds, maxSeconds } = calculateTargetDuration(
    videoDuration,
    0.04,
    keepPercentage
  );
  if (targetSeconds <= 0 || candidates.length === 0) return [];

  const minClip = Math.min(2, Math.max(0.5, Math.min(videoDuration * 0.01, targetSeconds * 0.08)));
  const maxSingleClip = Math.max(minClip * 1.5, targetSeconds * 0.48);

  const allBoundaries = [
    ...(boundaries?.transcriptBoundaries || []),
    ...(boundaries?.pauseBoundaries || []),
    ...(boundaries?.sceneBoundaries || []),
  ].sort((a, b) => a - b);

  const refined = candidates
    .filter((c) => c.combined_score >= 0.35)
    .map((c) => {
      let s =
        c.start_time <= 0.1
          ? c.start_time
          : snapStartToBoundary(c.start_time, allBoundaries, 1.8, 0.8);
      let e =
        c.end_time >= videoDuration - 0.1
          ? c.end_time
          : snapEndToBoundary(c.end_time, allBoundaries, 1.8, 0.8);
      s = Math.max(0, Math.min(videoDuration, s));
      e = Math.max(0, Math.min(videoDuration, e));
      if (e - s < minClip) {
        s = c.start_time;
        e = c.end_time;
      }
      if (e - s > maxSingleClip) {
        const origRole = classifySegmentRole({ ...c, start_time: s, end_time: e }, videoDuration);
        if (origRole === 'outro') {
          s = Math.max(0, e - maxSingleClip * 0.65);
        } else {
          e = s + maxSingleClip;
        }
      }
      const role = classifySegmentRole({ ...c, start_time: s, end_time: e }, videoDuration);
      return {
        ...c,
        start_time: s,
        end_time: e,
        duration: e - s,
        role,
      };
    })
    .filter((c) => c.duration >= minClip && c.duration <= maxSeconds);

  const selected: typeof refined = [];
  const quarterCounts = [0, 0, 0, 0];
  let accumulatedDuration = 0;
  const minSeparation = Math.min(1.5, videoDuration * 0.003);

  const overlapsSelected = (cand: { start_time: number; end_time: number }) =>
    selected.some(
      (sel) =>
        overlapRatio(sel.start_time, sel.end_time, cand.start_time, cand.end_time) > 0.08 ||
        (cand.start_time < sel.end_time + minSeparation &&
          cand.end_time > sel.start_time - minSeparation)
    );

  const canAddClip = (cand: (typeof refined)[number]) =>
    !overlapsSelected(cand) && accumulatedDuration + cand.duration <= maxSeconds;

  const commitClip = (cand: (typeof refined)[number]) => {
    selected.push(cand);
    accumulatedDuration += cand.duration;
    const q = Math.min(3, Math.floor((cand.start_time / Math.max(1, videoDuration)) * 4));
    quarterCounts[q]++;
  };

  // Step 1: Always incorporate the best Intro clip if one exists
  const introCandidates = refined
    .filter((c) => c.role === 'intro')
    .sort((a, b) => b.combined_score - a.combined_score);
  if (introCandidates.length > 0) {
    const intro = introCandidates[0];
    const maxIntroDur = Math.max(minClip, targetSeconds * 0.28);
    const clampedIntro =
      intro.duration > maxIntroDur
        ? {
            ...intro,
            end_time: snapEndToBoundary(intro.start_time + maxIntroDur, allBoundaries, 1.2, 0.8),
            duration: maxIntroDur,
          }
        : intro;
    clampedIntro.duration = clampedIntro.end_time - clampedIntro.start_time;
    if (canAddClip(clampedIntro)) {
      commitClip(clampedIntro);
    }
  }

  // Step 2: Always incorporate the best Outro clip if one exists and doesn't collide
  const outroCandidates = refined
    .filter((c) => c.role === 'outro' && !selected.includes(c))
    .sort((a, b) => b.combined_score - a.combined_score);
  if (outroCandidates.length > 0) {
    const outro = outroCandidates[0];
    const maxOutroDur = Math.max(minClip, targetSeconds * 0.26);
    const clampedOutro =
      outro.duration > maxOutroDur
        ? {
            ...outro,
            start_time: Math.max(
              0,
              snapStartToBoundary(outro.end_time - maxOutroDur, allBoundaries, 1.2, 0.8)
            ),
            duration: maxOutroDur,
          }
        : outro;
    clampedOutro.duration = clampedOutro.end_time - clampedOutro.start_time;
    if (canAddClip(clampedOutro)) {
      commitClip(clampedOutro);
    }
  }

  // Step 3: Fill with the highest-scoring Best Moments across the video until we reach targetSeconds
  const remaining = refined.filter(
    (c) => !selected.some((s) => s.start_time === c.start_time && s.end_time === c.end_time)
  );

  const computeSynergyBonus = (c: (typeof refined)[number]) => {
    const narrative = 0.6 * c.semantic_score + 0.4 * c.context_score;
    const sensory = Math.max((c.visual_score + c.audio_score) / 2, c.engagement_score);
    return narrative >= 0.76 && sensory >= 0.74
      ? Math.min(0.035, (narrative - 0.72) * (sensory - 0.7) * 0.4)
      : 0;
  };

  while (remaining.length > 0 && accumulatedDuration < targetSeconds) {
    remaining.sort((a, b) => {
      const qA = Math.min(3, Math.floor((a.start_time / Math.max(1, videoDuration)) * 4));
      const qB = Math.min(3, Math.floor((b.start_time / Math.max(1, videoDuration)) * 4));
      const bonusA =
        (quarterCounts[qA] === 0 ? 0.065 : quarterCounts[qA] === 1 ? 0.02 : 0) +
        computeSynergyBonus(a);
      const bonusB =
        (quarterCounts[qB] === 0 ? 0.065 : quarterCounts[qB] === 1 ? 0.02 : 0) +
        computeSynergyBonus(b);
      return b.combined_score + bonusB - (a.combined_score + bonusA);
    });

    const next = remaining.shift()!;
    if (overlapsSelected(next)) continue;

    if (accumulatedDuration + next.duration <= maxSeconds) {
      commitClip(next);
    } else {
      const needed = targetSeconds - accumulatedDuration;
      if (needed >= minClip) {
        const rawEnd = Math.min(videoDuration, next.start_time + needed);
        const snappedEnd = snapEndToBoundary(rawEnd, allBoundaries, 1.2, 0.8);
        const snappedDur = snappedEnd - next.start_time;
        const finalEnd =
          snappedDur >= minClip &&
          accumulatedDuration + snappedDur >= minSeconds &&
          accumulatedDuration + snappedDur <= maxSeconds
            ? snappedEnd
            : rawEnd;
        const trimmedDuration = finalEnd - next.start_time;

        if (
          trimmedDuration >= minClip &&
          accumulatedDuration + trimmedDuration <= maxSeconds &&
          !overlapsSelected({ start_time: next.start_time, end_time: finalEnd })
        ) {
          commitClip({
            ...next,
            end_time: finalEnd,
            duration: trimmedDuration,
          });
          break;
        }
      }
    }

    if (accumulatedDuration >= targetSeconds - 0.35 && accumulatedDuration <= maxSeconds) {
      break;
    }
  }

  // Sort chronologically by start_time so Intro is first, Best Moments are middle, and Outro is last
  selected.sort((a, b) => a.start_time - b.start_time);

  // Step 4: Coalesce adjacent clips separated by a tiny micro-gap (<= 2.5s) to prevent jarring jump cuts
  const maxMicroGap = Math.min(2.5, videoDuration * 0.008);
  if (selected.length > 2 && maxMicroGap > 0.2) {
    let i = 0;
    while (i < selected.length - 1 && selected.length > 2) {
      const curr = selected[i];
      const next = selected[i + 1];
      const gap = next.start_time - curr.end_time;
      if (
        gap >= 0 &&
        gap <= maxMicroGap &&
        accumulatedDuration + gap <= maxSeconds &&
        curr.role !== 'intro' &&
        next.role !== 'outro'
      ) {
        const keepNextMeta = next.combined_score > curr.combined_score;
        curr.end_time = next.end_time;
        curr.duration = curr.end_time - curr.start_time;
        if (keepNextMeta) {
          curr.title = next.title;
          curr.description = next.description;
          curr.reason = next.reason;
        }
        curr.semantic_score = Math.max(curr.semantic_score, next.semantic_score);
        curr.visual_score = Math.max(curr.visual_score, next.visual_score);
        curr.audio_score = Math.max(curr.audio_score, next.audio_score);
        curr.context_score = Math.max(curr.context_score, next.context_score);
        curr.ai_score = Math.max(curr.ai_score, next.ai_score);
        curr.engagement_score = Math.max(curr.engagement_score, next.engagement_score);
        curr.combined_score = Math.max(curr.combined_score, next.combined_score);
        accumulatedDuration += gap;
        selected.splice(i + 1, 1);
      } else {
        i++;
      }
    }
  }

  // Step 5: Fine-tune selected clips into available non-overlapping timeline gaps if accumulatedDuration is short of targetSeconds
  if (selected.length > 0 && targetSeconds - accumulatedDuration > 0.35) {
    for (let pass = 0; pass < 3 && targetSeconds - accumulatedDuration > 0.25; pass++) {
      const deficit = targetSeconds - accumulatedDuration;
      for (let i = 0; i < selected.length && targetSeconds - accumulatedDuration > 0.15; i++) {
        const clip = selected[i];
        const prevEnd = i === 0 ? 0 : selected[i - 1].end_time + minSeparation;
        const nextStart =
          i === selected.length - 1 ? videoDuration : selected[i + 1].start_time - minSeparation;
        const share = Math.min(
          targetSeconds - accumulatedDuration,
          deficit * Math.max(0.18, clip.duration / Math.max(1, accumulatedDuration))
        );
        if (share <= 0.05) continue;

        if (clip.role === 'outro') {
          const roomBefore = Math.max(0, clip.start_time - prevEnd);
          const addBefore = Math.min(share, roomBefore);
          if (addBefore > 0.05) {
            clip.start_time -= addBefore;
            clip.duration = clip.end_time - clip.start_time;
            accumulatedDuration += addBefore;
          }
        } else {
          const roomAfter = Math.max(0, nextStart - clip.end_time);
          const addAfter = Math.min(share * 0.72, roomAfter);
          if (addAfter > 0.05) {
            clip.end_time += addAfter;
            clip.duration = clip.end_time - clip.start_time;
            accumulatedDuration += addAfter;
          }
          const remShare = Math.min(share - addAfter, targetSeconds - accumulatedDuration);
          if (remShare > 0.05 && clip.role !== 'intro') {
            const roomBefore = Math.max(0, clip.start_time - prevEnd);
            const addBefore = Math.min(remShare, roomBefore);
            if (addBefore > 0.05) {
              clip.start_time -= addBefore;
              clip.duration = clip.end_time - clip.start_time;
              accumulatedDuration += addBefore;
            }
          }
        }
      }
    }
  }

  return selected.map((clip, idx) => ({
    start_time: clip.start_time,
    end_time: clip.end_time,
    title: clip.title,
    description: clip.description,
    semantic_score: clip.semantic_score,
    visual_score: clip.visual_score,
    audio_score: clip.audio_score,
    context_score: clip.context_score,
    ai_score: clip.ai_score,
    engagement_score: clip.engagement_score,
    combined_score: clip.combined_score,
    reason: clip.reason,
    sequence_order: idx + 1,
    role: clip.role,
  }));
}

/**
 * Verifies that an uploaded source video file matches the intended YouTube video duration
 * within a safe tolerance (max(5s, 5% of expected duration)).
 */
export function verifySourceMediaDuration(
  expectedDurationSeconds: number,
  actualDurationSeconds: number
): {
  valid: boolean;
  deltaSeconds: number;
  toleranceSeconds: number;
  reason?: string;
} {
  if (
    !Number.isFinite(expectedDurationSeconds) ||
    !Number.isFinite(actualDurationSeconds) ||
    expectedDurationSeconds <= 0 ||
    actualDurationSeconds <= 0
  ) {
    return {
      valid: false,
      deltaSeconds: Math.abs((expectedDurationSeconds || 0) - (actualDurationSeconds || 0)),
      toleranceSeconds: 0,
      reason: 'Could not read valid duration from media file.',
    };
  }

  const deltaSeconds = Math.abs(expectedDurationSeconds - actualDurationSeconds);
  const toleranceSeconds = Math.max(5, expectedDurationSeconds * 0.05);

  if (deltaSeconds > toleranceSeconds) {
    return {
      valid: false,
      deltaSeconds,
      toleranceSeconds,
      reason: `Uploaded video duration (${formatTimestamp(
        actualDurationSeconds
      )}) differs from analyzed video duration (${formatTimestamp(
        expectedDurationSeconds
      )}) by ${formatDurationSeconds(deltaSeconds)} (allowed tolerance: ±${formatDurationSeconds(
        toleranceSeconds
      )}).`,
    };
  }

  return {
    valid: true,
    deltaSeconds,
    toleranceSeconds,
  };
}

/**
 * Computes a deterministic render cache signature for a compiled highlight reel
 * based on the source video ID, keep percentage, and ordered clip timestamps.
 */
export function computeClipRenderSignature(
  videoId: string,
  keepPercentage: number,
  segments: Pick<HighlightSegmentRecord, 'start_time' | 'end_time'>[]
): string {
  const validPct = clampKeepPercentage(keepPercentage);
  const clipKey = segments
    .map((s) => `${s.start_time.toFixed(3)}-${s.end_time.toFixed(3)}`)
    .join('|');
  return `${videoId}::${validPct}::${clipKey}::hq-v2`;
}

/**
 * Validates and normalizes a per-browser client session token so each user's videos
 * remain isolated to their own device and are never saved or listed for other users.
 */
export function sanitizeClientId(rawClientId: unknown): string | null {
  if (typeof rawClientId !== 'string') return null;
  const trimmed = rawClientId.trim();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

/**
 * Determines whether a compiled highlight job belongs to the requesting browser client.
 * Jobs without an explicit matching owner_client_id are never exposed in another user's library.
 */
export function isJobVisibleToClient(
  job: Pick<HighlightJobRecord, 'owner_client_id'>,
  requestClientId: string | null | undefined
): boolean {
  const validClient = sanitizeClientId(requestClientId);
  const validOwner = sanitizeClientId(job.owner_client_id);
  if (!validClient || !validOwner) {
    return false;
  }
  return validClient === validOwner;
}

/**
 * Selects high-definition output dimensions and target encoding bitrate
 * without duration-based bitrate throttling.
 */
export function selectTargetOutputResolution(
  sourceWidth: number,
  sourceHeight: number
): {
  width: number;
  height: number;
  label: '1080p Full HD' | '720p HD';
  targetMaxBitrateKbps: number;
} {
  if (sourceHeight >= 1080 || sourceWidth >= 1920) {
    return {
      width: 1920,
      height: 1080,
      label: '1080p Full HD',
      targetMaxBitrateKbps: 8500,
    };
  }
  return {
    width: 1280,
    height: 720,
    label: '720p HD',
    targetMaxBitrateKbps: 6000,
  };
}
