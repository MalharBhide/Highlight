import type { AICandidateHighlight, EngagementPoint, VideoRecord } from './highlightEngine.ts';

function buildSvgDataUri(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg.trim())}`;
}

export const KEYNOTE_THUMBNAIL_SVG = buildSvgDataUri(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" width="1280" height="720">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#090D16"/>
      <stop offset="55%" stop-color="#111827"/>
      <stop offset="100%" stop-color="#1E1B4B"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#F59E0B"/>
      <stop offset="100%" stop-color="#EA580C"/>
    </linearGradient>
  </defs>
  <rect width="1280" height="720" fill="url(#bg)"/>
  <g stroke="#1F2937" stroke-width="1" opacity="0.55">
    <line x1="0" y1="180" x2="1280" y2="180"/>
    <line x1="0" y1="360" x2="1280" y2="360"/>
    <line x1="0" y1="540" x2="1280" y2="540"/>
    <line x1="320" y1="0" x2="320" y2="720"/>
    <line x1="640" y1="0" x2="640" y2="720"/>
    <line x1="960" y1="0" x2="960" y2="720"/>
  </g>
  <path d="M 80 500 Q 220 480, 310 340 T 520 420 T 760 220 T 980 390 T 1200 260" fill="none" stroke="url(#accent)" stroke-width="5"/>
  <path d="M 80 500 Q 220 480, 310 340 T 520 420 T 760 220 T 980 390 T 1200 260 L 1200 620 L 80 620 Z" fill="url(#accent)" opacity="0.14"/>
  <circle cx="310" cy="340" r="8" fill="#F59E0B"/>
  <circle cx="760" cy="220" r="10" fill="#F59E0B"/>
  <circle cx="1110" cy="295" r="8" fill="#F59E0B"/>
  <rect x="140" y="96" width="260" height="38" rx="6" fill="#1F2937"/>
  <text x="160" y="120" fill="#F59E0B" font-family="monospace" font-size="16" font-weight="600">KEYNOTE SESSION · 05:00</text>
  <text x="140" y="195" fill="#F9FAFB" font-family="sans-serif" font-size="42" font-weight="700">Multimodal Systems Keynote</text>
  <text x="140" y="242" fill="#9CA3AF" font-family="sans-serif" font-size="21">Live Latency Benchmarks &amp; Audio Reasoning</text>
</svg>
`);

export const ROBOTICS_THUMBNAIL_SVG = buildSvgDataUri(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" width="1280" height="720">
  <defs>
    <linearGradient id="bg2" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0A0F14"/>
      <stop offset="60%" stop-color="#0F172A"/>
      <stop offset="100%" stop-color="#1E293B"/>
    </linearGradient>
  </defs>
  <rect width="1280" height="720" fill="url(#bg2)"/>
  <g stroke="#334155" stroke-width="1.5" opacity="0.35">
    <circle cx="920" cy="360" r="210" fill="none"/>
    <circle cx="920" cy="360" r="140" fill="none"/>
    <circle cx="920" cy="360" r="70" fill="none"/>
    <line x1="680" y1="360" x2="1160" y2="360"/>
    <line x1="920" y1="120" x2="920" y2="600"/>
  </g>
  <polyline points="820,440 890,310 970,350 1030,230" fill="none" stroke="#38BDF8" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="820" cy="440" r="9" fill="#38BDF8"/>
  <circle cx="890" cy="310" r="9" fill="#38BDF8"/>
  <circle cx="970" cy="350" r="9" fill="#38BDF8"/>
  <circle cx="1030" cy="230" r="11" fill="#F59E0B"/>
  <rect x="140" y="96" width="280" height="38" rx="6" fill="#1E293B"/>
  <text x="160" y="120" fill="#38BDF8" font-family="monospace" font-size="16" font-weight="600">KEYNOTE PART II · 10:12</text>
  <text x="140" y="195" fill="#F8FAFC" font-family="sans-serif" font-size="42" font-weight="700">Multimodal Edge Inference</text>
  <text x="140" y="242" fill="#94A3B8" font-family="sans-serif" font-size="21">Low-Latency Video Streaming &amp; Frame Indexing</text>
</svg>
`);

export interface DevelopmentFixtureSpec {
  video: VideoRecord;
  engagementAvailable: boolean;
  engagementSource: 'authorized_channel_fixture' | 'unavailable';
  hasPrebuiltSourceFile: boolean;
  videoSummary: string;
  videoCategory: string;
  engagementObservations: EngagementPoint[];
  aiHighlights: AICandidateHighlight[];
  sceneBoundaries: number[];
}

export const DEVELOPMENT_FIXTURES: Record<string, DevelopmentFixtureSpec> = {
  'dev-keynote-01': {
    video: {
      id: 'vid-dev-keynote-01',
      youtube_video_id: 'dev-keynote-01',
      title: 'Multimodal Systems Keynote: Real-Time Video & Audio Reasoning',
      channel: 'AI Systems Engineering Summit',
      duration: 304.64,
      thumbnail: KEYNOTE_THUMBNAIL_SVG,
      description:
        'Engineering keynote covering unified multimodal video understanding, sub-200ms audio response latency, and real-time event detection.',
      original_url: 'https://www.youtube.com/watch?v=dev-keynote-01',
      is_fixture: true,
    },
    engagementAvailable: true,
    engagementSource: 'authorized_channel_fixture',
    hasPrebuiltSourceFile: true,
    videoSummary:
      'An engineering keynote demonstrating unified multimodal video understanding, sub-200ms audio response latency, and long-horizon temporal retrieval across high-density video streams.',
    videoCategory: 'Technology & Engineering Keynote',
    sceneBoundaries: [0, 8.74, 21.85, 38.12, 117.42, 141.18, 178.35, 195.8, 237.64, 255.91, 294.82, 304.64],
    engagementObservations: Array.from({ length: 61 }, (_, i) => {
      const ratio = i / 60;
      const t = ratio * 304.64;
      let watch = 0.72 - ratio * 0.24;
      let rel = 0.54;
      if (t >= 20 && t <= 44) {
        watch += 0.22 * Math.sin(((t - 20) / 24) * Math.PI);
        rel = 0.86;
      }
      if (t >= 115 && t <= 145) {
        watch += 0.35 * Math.sin(((t - 115) / 30) * Math.PI);
        rel = 0.96;
      }
      if (t >= 235 && t <= 262) {
        watch += 0.29 * Math.sin(((t - 235) / 27) * Math.PI);
        rel = 0.91;
      }
      return {
        elapsedVideoTimeRatio: ratio,
        audienceWatchRatio: Math.min(1, watch),
        relativeRetentionPerformance: rel,
      };
    }),
    aiHighlights: [
      {
        start_time: 21.85,
        end_time: 38.12,
        title: 'Unified Frame-and-Waveform Architecture Reveal',
        description:
          'Speaker introduces how native joint tokenization of video frames and acoustic waveforms eliminates cross-modal information loss.',
        semantic_score: 0.91,
        visual_score: 0.84,
        audio_score: 0.76,
        context_score: 0.94,
        reason:
          'Essential narrative setup with high semantic density and strong audience retention.',
      },
      {
        start_time: 78.2,
        end_time: 91.65,
        title: 'Brief Audience Applause Interlude',
        description: 'Loud applause transition between slides with minimal spoken technical content.',
        semantic_score: 0.28,
        visual_score: 0.35,
        audio_score: 0.95,
        context_score: 0.25,
        reason: 'High audio amplitude alone; ranked lower by unified multi-signal scoring.',
      },
      {
        start_time: 117.42,
        end_time: 141.18,
        title: 'Live Sub-200ms Multimodal Benchmark Breakthrough',
        description:
          'Live side-by-side latency test showing real-time event detection across a 60fps stream with audience reaction.',
        semantic_score: 0.97,
        visual_score: 0.93,
        audio_score: 0.88,
        context_score: 0.9,
        reason:
          'Highest combined semantic turning point, live visual demonstration, and #1 audience replay spike.',
      },
      {
        start_time: 178.35,
        end_time: 195.8,
        title: 'Failure Mode Recovery in Occluded Scenes',
        description:
          'Demonstration of temporal context tracking when visual targets are briefly occluded.',
        semantic_score: 0.82,
        visual_score: 0.86,
        audio_score: 0.7,
        context_score: 0.78,
        reason: 'Strong visual demonstration supporting the middle section.',
      },
      {
        start_time: 237.64,
        end_time: 255.91,
        title: 'SDK Release & Production Availability Announcement',
        description:
          'Major closing announcement detailing immediate developer access, rate limits, and key takeaways.',
        semantic_score: 0.94,
        visual_score: 0.85,
        audio_score: 0.84,
        context_score: 0.92,
        reason:
          'Major concluding payoff and announcement corroborated by late-video retention peak.',
      },
    ],
  },
  'dev-robotics-02': {
    video: {
      id: 'vid-dev-robotics-02',
      youtube_video_id: 'dev-robotics-02',
      title: 'Multimodal Systems Deep Dive: Low-Latency Streaming & Frame Indexing',
      channel: 'AI Systems Engineering Summit',
      duration: 612.48,
      thumbnail: ROBOTICS_THUMBNAIL_SVG,
      description:
        'Companion engineering session to the Multimodal Systems Keynote covering streaming video frame indexing, real-time audio alignment, and edge inference.',
      original_url: 'https://www.youtube.com/watch?v=dev-robotics-02',
      is_fixture: true,
    },
    engagementAvailable: false,
    engagementSource: 'unavailable',
    hasPrebuiltSourceFile: true,
    videoSummary:
      'Companion technical session detailing streaming video frame indexing, real-time audio alignment, and low-latency edge inference.',
    videoCategory: 'Technology & Engineering Keynote',
    sceneBoundaries: [0, 16.38, 45.12, 72.84, 189.45, 221.73, 341.18, 376.62, 488.91, 511.27, 596.84, 612.48],
    engagementObservations: [],
    aiHighlights: [
      {
        start_time: 45.12,
        end_time: 72.84,
        title: 'Streaming Video Frame Tokenizer & Ring Buffer Setup',
        description:
          'Speaker walks through the continuous ring-buffer architecture used for zero-copy video frame ingestion.',
        semantic_score: 0.9,
        visual_score: 0.85,
        audio_score: 0.74,
        context_score: 0.93,
        reason: 'Foundational pipeline setup directly building on the keynote architecture.',
      },
      {
        start_time: 189.45,
        end_time: 221.73,
        title: 'Live Cross-Modal Audio-Visual Timestamp Alignment Demo',
        description:
          'Live demonstration aligning spoken technical commentary with high-motion screen transitions in real time.',
        semantic_score: 0.96,
        visual_score: 0.95,
        audio_score: 0.82,
        context_score: 0.89,
        reason: 'Primary live demonstration validating cross-modal synchronization.',
      },
      {
        start_time: 341.18,
        end_time: 376.62,
        title: 'Long-Context Temporal Retrieval Across Multi-Hour Streams',
        description:
          'Deep dive into hierarchical keyframe indexing for sub-second clip retrieval across long-form recordings.',
        semantic_score: 0.91,
        visual_score: 0.92,
        audio_score: 0.75,
        context_score: 0.85,
        reason: 'High visual and semantic importance explaining long-video scaling.',
      },
      {
        start_time: 488.91,
        end_time: 511.27,
        title: 'End-to-End Throughput & Memory Footprint Benchmarks',
        description:
          'Quantitative benchmark summary comparing streaming multimodal inference against batch processing.',
        semantic_score: 0.94,
        visual_score: 0.8,
        audio_score: 0.78,
        context_score: 0.92,
        reason: 'Essential quantitative conclusion wrapping up the companion session.',
      },
    ],
  },
};
