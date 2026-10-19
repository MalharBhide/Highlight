import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractYouTubeVideoId,
  extractSharedReelJobId,
  parseIsoDuration,
  formatTimestamp,
  clampKeepPercentage,
  formatVideoDownloadFilename,
  calculateTargetDuration,
  analyzeEngagementTimeline,
  validateAndClampAICandidates,
  ensureCandidateCoverageForTarget,
  scoreAndMergeCandidates,
  selectHighlightReel,
  verifySourceMediaDuration,
  computeClipRenderSignature,
  sanitizeClientId,
  isJobVisibleToClient,
  selectTargetOutputResolution,
  snapStartToBoundary,
  snapEndToBoundary,
} from './highlightEngine.ts';

test('extractYouTubeVideoId validates standard, short, and shorts URLs and rejects invalid ones', () => {
  assert.equal(
    extractYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
    'dQw4w9WgXcQ'
  );
  assert.equal(extractYouTubeVideoId('https://youtu.be/dQw4w9WgXcQ?t=42'), 'dQw4w9WgXcQ');
  assert.equal(
    extractYouTubeVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ'),
    'dQw4w9WgXcQ'
  );
  assert.equal(extractYouTubeVideoId('dev-keynote-01'), 'dev-keynote-01');
  assert.equal(extractYouTubeVideoId('https://vimeo.com/123456789'), null);
  assert.equal(extractYouTubeVideoId('https://www.youtube.com/watch?v=short'), null);
  assert.equal(extractYouTubeVideoId(''), null);
});

test('extractSharedReelJobId extracts reel job IDs from query, hash, path, or raw ID', () => {
  assert.equal(
    extractSharedReelJobId('https://example.com/?reel=job-mvc45iwv-6j8a'),
    'job-mvc45iwv-6j8a'
  );
  assert.equal(
    extractSharedReelJobId('https://example.com/reel/job-seed-dev-keynote-01#reel=job-seed-dev-keynote-01'),
    'job-seed-dev-keynote-01'
  );
  assert.equal(extractSharedReelJobId('job-mvc7hq50-rd4h'), 'job-mvc7hq50-rd4h');
  assert.equal(extractSharedReelJobId('https://www.youtube.com/watch?v=M7lc1UVf-VE'), null);
});

test('parseIsoDuration parses YouTube Data API v3 ISO-8601 durations accurately', () => {
  assert.equal(parseIsoDuration('PT5M'), 300);
  assert.equal(parseIsoDuration('PT15M33S'), 933);
  assert.equal(parseIsoDuration('PT1H2M10S'), 3730);
});

test('formatTimestamp formats time as min:sec without milliseconds or rounding up', () => {
  assert.equal(formatTimestamp(85.43), '01:25');
  assert.equal(formatTimestamp(890.253061), '14:50');
  assert.equal(formatTimestamp(1.74), '00:01');
  assert.equal(formatTimestamp(60), '01:00');
});

test('calculateTargetDuration follows T_highlight = (keepPercentage / 100) * T_original (5% to 50%, step 5, default 20%)', () => {
  assert.equal(clampKeepPercentage(undefined), 20);
  assert.equal(clampKeepPercentage(1), 5);
  assert.equal(clampKeepPercentage(5), 5);
  assert.equal(clampKeepPercentage(12), 10);
  assert.equal(clampKeepPercentage(13), 15);
  assert.equal(clampKeepPercentage(35), 35);
  assert.equal(clampKeepPercentage(50), 50);
  assert.equal(clampKeepPercentage(85), 50);

  // Default 20%: 5 minutes -> 1 minute (60s)
  assert.equal(calculateTargetDuration(5 * 60).targetSeconds, 60);
  // 5% keep: 10 minutes (600s) -> 30s
  assert.equal(calculateTargetDuration(600, 0.04, 5).targetSeconds, 30);
  // 50% keep: 10 minutes (600s) -> 300s
  assert.equal(calculateTargetDuration(600, 0.04, 50).targetSeconds, 300);
  // 120 minutes -> 24 minutes (1440s, no fixed 600s cap)
  const long120 = calculateTargetDuration(120 * 60);
  assert.equal(long120.targetSeconds, 1440);
  // Unrounded duration 890.253061s -> exact 20% = 178.0506122s without rounding
  const exact = calculateTargetDuration(890.253061);
  assert.ok(Math.abs(exact.targetSeconds - 178.0506122) < 1e-6);
});

test('formatVideoDownloadFilename uses actual video title sanitized for MP4 download', () => {
  assert.equal(
    formatVideoDownloadFilename('YouTube Developers Live: Embedded Web Player Customization', 'M7lc1UVf-VE'),
    'YouTube Developers Live Embedded Web Player Customization.mp4'
  );
  assert.equal(
    formatVideoDownloadFilename('I couldn’t stop myself', 'HwMaRomHksQ'),
    'I couldn’t stop myself.mp4'
  );
  assert.equal(
    formatVideoDownloadFilename('', 'M7lc1UVf-VE'),
    'highlight-M7lc1UVf-VE.mp4'
  );
});

test('analyzeEngagementTimeline detects local prominence peaks rather than favoring early baseline decay', () => {
  const points = Array.from({ length: 50 }, (_, i) => {
    const ratio = i / 49;
    // Slight natural decay from start, plus two genuine spikes at ratio ~0.40 and ~0.78
    let watch = 0.65 - ratio * 0.2;
    let rel = 0.5;
    if (i >= 19 && i <= 21) {
      watch += 0.32;
      rel = 0.94;
    }
    if (i >= 37 && i <= 39) {
      watch += 0.36;
      rel = 0.98;
    }
    return {
      elapsedVideoTimeRatio: ratio,
      audienceWatchRatio: watch,
      relativeRetentionPerformance: rel,
    };
  });

  const { smoothedTimeline, peaks } = analyzeEngagementTimeline(points, 600);
  assert.equal(smoothedTimeline.length, 50);
  assert.ok(peaks.length >= 2, 'Should detect the two prominent mid/late peaks');
  // Top peaks should be near 0.40 * 600 (~240s) and 0.78 * 600 (~468s), not at 0s
  assert.ok(peaks[0].peak_time > 180, 'Top peak should not be the start of the video');
});

test('scoreAndMergeCandidates applies 40/25/15/10/10 weights, redistributes when engagement missing, and penalizes loudness-only', () => {
  const aiCandidates = [
    {
      start_time: 30.15,
      end_time: 50.42,
      title: 'Loud noise without substance',
      description: 'Brief microphone bump and loud cheer with minimal context',
      semantic_score: 0.25,
      visual_score: 0.3,
      audio_score: 0.98,
      context_score: 0.2,
      reason: 'High audio amplitude',
    },
    {
      start_time: 120.38,
      end_time: 150.84,
      title: 'Core architecture breakthrough',
      description: 'Key live demonstration and turning point explanation',
      semantic_score: 0.95,
      visual_score: 0.88,
      audio_score: 0.78,
      context_score: 0.92,
      reason: 'Primary turning point in presentation',
    },
  ];

  const peaks = [
    {
      start_time: 118.2,
      end_time: 152.6,
      peak_time: 135.4,
      prominence: 0.92,
      intensity: 0.89,
      consistency: 0.95,
      separation_score: 0.85,
      engagement_score: 0.9,
    },
  ];

  // With engagement
  const withEng = scoreAndMergeCandidates(aiCandidates, peaks, {
    engagementAvailable: true,
    audioAvailable: true,
    videoDuration: 300,
  });

  assert.equal(withEng[0].title, 'Core architecture breakthrough');
  assert.ok(
    withEng[0].combined_score > withEng[1].combined_score + 0.3,
    'Multi-signal moment must strongly outrank loudness-only candidate'
  );

  // Without engagement (weights redistribute proportionally across remaining 75%)
  const withoutEng = scoreAndMergeCandidates(aiCandidates, [], {
    engagementAvailable: false,
    audioAvailable: true,
    videoDuration: 300,
  });
  assert.equal(withoutEng[0].engagement_score, 0);
  assert.ok(withoutEng[0].combined_score >= 0.9 && withoutEng[0].combined_score <= 0.92);
});

test('selectHighlightReel meets ~20% duration target with unrounded variable-length clips in chronological order', () => {
  // 300.48s video -> target ~60.096s highlight reel
  const candidates = [
    {
      start_time: 262.14,
      end_time: 280.62,
      title: 'Final synthesis & conclusion',
      description: 'Closing takeaway',
      semantic_score: 0.92,
      visual_score: 0.85,
      audio_score: 0.8,
      context_score: 0.9,
      ai_score: 0.89,
      engagement_score: 0.88,
      combined_score: 0.89,
      reason: 'Strong concluding payoff',
    },
    {
      start_time: 11.28,
      end_time: 26.94,
      title: 'Opening problem thesis',
      description: 'Core setup',
      semantic_score: 0.9,
      visual_score: 0.82,
      audio_score: 0.75,
      context_score: 0.94,
      ai_score: 0.87,
      engagement_score: 0.84,
      combined_score: 0.86,
      reason: 'Essential narrative setup',
    },
    {
      start_time: 118.42,
      end_time: 144.36,
      title: 'Live benchmark reveal',
      description: 'Middle turning point',
      semantic_score: 0.96,
      visual_score: 0.9,
      audio_score: 0.85,
      context_score: 0.88,
      ai_score: 0.92,
      engagement_score: 0.94,
      combined_score: 0.93,
      reason: 'Highest semantic and replay peak',
    },
    {
      start_time: 122.1,
      end_time: 142.8,
      title: 'Duplicate overlapping benchmark',
      description: 'Overlaps middle turning point',
      semantic_score: 0.85,
      visual_score: 0.8,
      audio_score: 0.75,
      context_score: 0.8,
      ai_score: 0.82,
      engagement_score: 0.8,
      combined_score: 0.81,
      reason: 'Redundant overlap',
    },
  ];

  const selected = selectHighlightReel(candidates, 300.48, {
    sceneBoundaries: [11.28, 26.94, 118.42, 144.36, 262.14, 280.62],
  });

  assert.equal(selected.length, 3);
  const totalSelectedSeconds = selected.reduce(
    (acc, seg) => acc + (seg.end_time - seg.start_time),
    0
  );
  // Target is ~60.096s (±15% tolerance)
  assert.ok(
    totalSelectedSeconds >= 50 && totalSelectedSeconds <= 68,
    `Expected total duration ~60.1s, got ${totalSelectedSeconds}s`
  );

  // Verify unrounded timestamps and variable clip lengths
  const durations = selected.map((s) => s.end_time - s.start_time);
  assert.notEqual(durations[0], durations[1], 'Clips should have natural variable durations');
  assert.ok(
    selected.some((s) => !Number.isInteger(s.start_time) || !Number.isInteger(s.end_time)),
    'Timestamps must not be rounded to integers'
  );

  // Verify chronological ordering
  for (let i = 1; i < selected.length; i++) {
    assert.ok(
      selected[i].start_time >= selected[i - 1].end_time,
      'Selected segments must be in non-overlapping chronological order'
    );
    assert.equal(selected[i].sequence_order, i + 1);
  }
});

test('validateAndClampAICandidates clamps out-of-range timestamps without rounding fractional seconds', () => {
  const validated = validateAndClampAICandidates(
    {
      video_summary: 'Test summary',
      video_category: 'Education',
      highlights: [
        {
          start_time: -5,
          end_time: 25.37,
          title: 'Clamped start',
          description: 'Desc',
          semantic_score: 0.9,
          visual_score: 0.8,
          audio_score: 0.7,
          context_score: 0.85,
          reason: 'Valid after clamp',
        },
        {
          start_time: 180.64,
          end_time: 250,
          title: 'Clamped end',
          description: 'Desc',
          semantic_score: 0.85,
          visual_score: 0.8,
          audio_score: 0.7,
          context_score: 0.8,
          reason: 'Valid after end clamp',
        },
        {
          start_time: 100,
          end_time: 90,
          title: 'Invalid reversed',
          description: 'Should be rejected',
        },
      ],
    },
    200.42
  );

  assert.equal(validated.highlights.length, 2);
  assert.equal(validated.highlights[0].start_time, 0);
  assert.equal(validated.highlights[0].end_time, 25.37);
  assert.equal(validated.highlights[1].start_time, 180.64);
  assert.equal(validated.highlights[1].end_time, 200.42);
});

test('verifySourceMediaDuration validates matching video files and rejects mismatched files', () => {
  assert.equal(verifySourceMediaDuration(300.25, 302.14).valid, true);
  assert.equal(verifySourceMediaDuration(300.25, 180.0).valid, false);
});

test('ensureCandidateCoverageForTarget and selectHighlightReel support custom keepPercentage from 5% to 50%', () => {
  const sparse = [
    {
      start_time: 10.42,
      end_time: 28.19,
      title: 'Intro hook',
      description: 'Short clip 1',
      semantic_score: 0.9,
      visual_score: 0.8,
      audio_score: 0.7,
      context_score: 0.9,
      reason: 'Opening',
    },
    {
      start_time: 200.64,
      end_time: 221.38,
      title: 'Mid point',
      description: 'Short clip 2',
      semantic_score: 0.85,
      visual_score: 0.75,
      audio_score: 0.7,
      context_score: 0.85,
      reason: 'Middle',
    },
  ];

  // 1) Default 20% on 600.75s video -> ~120.15s
  const covered20 = ensureCandidateCoverageForTarget(sparse, 600.75, 20);
  const scored20 = scoreAndMergeCandidates(covered20, [], {
    engagementAvailable: false,
    videoDuration: 600.75,
  });
  const selected20 = selectHighlightReel(scored20, 600.75, undefined, 20);
  const totalDur20 = selected20.reduce((sum, s) => sum + (s.end_time - s.start_time), 0);
  assert.ok(
    totalDur20 >= 105 && totalDur20 <= 135,
    `Expected ~120.15s highlight reel at 20%, got ${totalDur20}s`
  );
  assert.equal(selected20[0].role, 'intro');
  assert.equal(selected20[selected20.length - 1].role, 'outro');

  // 2) 5% on 600.75s video -> ~30.04s
  const covered5 = ensureCandidateCoverageForTarget(sparse, 600.75, 5);
  const scored5 = scoreAndMergeCandidates(covered5, [], {
    engagementAvailable: false,
    videoDuration: 600.75,
  });
  const selected5 = selectHighlightReel(scored5, 600.75, undefined, 5);
  const totalDur5 = selected5.reduce((sum, s) => sum + (s.end_time - s.start_time), 0);
  assert.ok(
    totalDur5 >= 24 && totalDur5 <= 35,
    `Expected ~30s highlight reel at 5%, got ${totalDur5}s`
  );

  // 3) 50% on 600.75s video -> ~300.38s
  const covered50 = ensureCandidateCoverageForTarget(sparse, 600.75, 50);
  const scored50 = scoreAndMergeCandidates(covered50, [], {
    engagementAvailable: false,
    videoDuration: 600.75,
  });
  const selected50 = selectHighlightReel(scored50, 600.75, undefined, 50);
  const totalDur50 = selected50.reduce((sum, s) => sum + (s.end_time - s.start_time), 0);
  assert.ok(
    totalDur50 >= 270 && totalDur50 <= 330,
    `Expected ~300s highlight reel at 50%, got ${totalDur50}s`
  );
});

test('computeClipRenderSignature generates deterministic cache keys and distinguishes different percentages or cuts', () => {
  const segsA = [
    { start_time: 0, end_time: 12.345 },
    { start_time: 45.678, end_time: 89.012 },
  ];
  const sig1 = computeClipRenderSignature('vid-M7lc1UVf-VE', 20, segsA);
  const sig2 = computeClipRenderSignature('vid-M7lc1UVf-VE', 20, segsA);
  const sigDifferentPct = computeClipRenderSignature('vid-M7lc1UVf-VE', 25, segsA);
  const sigDifferentCut = computeClipRenderSignature('vid-M7lc1UVf-VE', 20, [
    { start_time: 0, end_time: 12.345 },
    { start_time: 45.678, end_time: 90.012 },
  ]);

  assert.equal(sig1, sig2);
  assert.notEqual(sig1, sigDifferentPct);
  assert.notEqual(sig1, sigDifferentCut);
});

test('sanitizeClientId and isJobVisibleToClient enforce strict per-user video isolation', () => {
  assert.equal(sanitizeClientId('client-9f8a7b6c-1234-5678'), 'client-9f8a7b6c-1234-5678');
  assert.equal(sanitizeClientId('short'), null);
  assert.equal(sanitizeClientId('invalid spaces or $ymbols!'), null);
  assert.equal(sanitizeClientId(null), null);

  const userAJob = { owner_client_id: 'client-user-a-12345678' };
  const unownedJob = { owner_client_id: undefined };

  assert.equal(isJobVisibleToClient(userAJob, 'client-user-a-12345678'), true);
  assert.equal(isJobVisibleToClient(userAJob, 'client-user-b-87654321'), false);
  assert.equal(isJobVisibleToClient(userAJob, null), false);
  assert.equal(isJobVisibleToClient(unownedJob, 'client-user-a-12345678'), false);
});

test('selectTargetOutputResolution preserves 1080p Full HD and uses high bitrate without duration throttling', () => {
  const fullHd = selectTargetOutputResolution(1920, 1080);
  assert.equal(fullHd.width, 1920);
  assert.equal(fullHd.height, 1080);
  assert.equal(fullHd.label, '1080p Full HD');
  assert.ok(fullHd.targetMaxBitrateKbps >= 8000);

  const hd720 = selectTargetOutputResolution(1280, 720);
  assert.equal(hd720.width, 1280);
  assert.equal(hd720.height, 720);
  assert.equal(hd720.label, '720p HD');
  assert.ok(hd720.targetMaxBitrateKbps >= 5000);
});

test('snapStartToBoundary and snapEndToBoundary preserve setup lead-in and payoff completion', () => {
  // When boundaries exist equidistant before and after, start prefers earlier and end prefers later
  const startSnapped = snapStartToBoundary(50.0, [49.2, 50.7], 1.8, 0.8);
  assert.equal(startSnapped, 49.2);

  const endSnapped = snapEndToBoundary(80.0, [79.3, 80.8], 1.8, 0.8);
  assert.equal(endSnapped, 80.8);
});

test('selectHighlightReel coalesces micro-gaps between adjacent highlight segments to prevent jump cuts', () => {
  const candidates = scoreAndMergeCandidates(
    [
      {
        start_time: 0,
        end_time: 10,
        title: 'Intro Hook',
        description: 'Opening hook',
        role: 'intro',
        semantic_score: 0.9,
        visual_score: 0.85,
        audio_score: 0.8,
        context_score: 0.92,
        reason: 'Strong opening setup',
      },
      {
        start_time: 100,
        end_time: 118,
        title: 'Core Exchange Part 1',
        description: 'Setup of the main demonstration',
        role: 'highlight',
        semantic_score: 0.92,
        visual_score: 0.88,
        audio_score: 0.86,
        context_score: 0.9,
        reason: 'Setup of key demonstration',
      },
      {
        start_time: 119.8,
        end_time: 138,
        title: 'Core Exchange Payoff',
        description: 'Immediate payoff 1.8s later',
        role: 'highlight',
        semantic_score: 0.96,
        visual_score: 0.92,
        audio_score: 0.91,
        context_score: 0.94,
        reason: 'Immediate climax after 1.8s breath',
      },
      {
        start_time: 260,
        end_time: 282,
        title: 'Second Highlight',
        description: 'Another strong segment',
        role: 'highlight',
        semantic_score: 0.89,
        visual_score: 0.85,
        audio_score: 0.84,
        context_score: 0.88,
        reason: 'High engagement moment',
      },
      {
        start_time: 388,
        end_time: 400,
        title: 'Closing Wrap-Up',
        description: 'Outro sign-off',
        role: 'outro',
        semantic_score: 0.88,
        visual_score: 0.82,
        audio_score: 0.8,
        context_score: 0.91,
        reason: 'Clean conclusion',
      },
    ],
    [],
    {
      engagementAvailable: false,
      audioAvailable: true,
      videoDuration: 400,
    }
  );

  const reel = selectHighlightReel(candidates, 400, undefined, 22);
  const coalesced = reel.find((s) => s.start_time <= 100.5 && s.end_time >= 137.5);
  assert.ok(coalesced, 'Expected adjacent highlight clips separated by 1.8s micro-gap to coalesce into one continuous scene');
});

