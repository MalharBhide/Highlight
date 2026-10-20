import React, { useState, useEffect } from 'react';
import {
  Loader2,
  AlertCircle,
  RotateCcw,
  ArrowLeft,
  Film,
  Check,
} from 'lucide-react';
import {
  formatTimestamp,
  calculateTargetDuration,
  clampKeepPercentage,
  type HighlightJobRecord,
  type VideoRecord,
} from '../lib/highlightEngine';

interface ProcessingViewProps {
  darkMode: boolean;
  job: HighlightJobRecord;
  video: VideoRecord;
  keepPercentage: number;
  onRetry: () => Promise<void>;
  onCancel: () => void;
}

const PIPELINE_PHASES = [
  {
    id: 1,
    label: 'Acquire HD source video & verify stream metadata',
    threshold: 25,
  },
  {
    id: 2,
    label: 'Extract 48kHz audio energy & speech-pause boundaries',
    threshold: 60,
  },
  {
    id: 3,
    label: 'Score & snap intro, best moments & outro clips',
    threshold: 85,
  },
  {
    id: 4,
    label: 'Stitch & encode HD H.264 MP4 video with stereo audio',
    threshold: 99,
  },
];

export const ProcessingView: React.FC<ProcessingViewProps> = ({
  darkMode,
  job,
  video,
  keepPercentage,
  onRetry,
  onCancel,
}) => {
  const [imgError, setImgError] = useState(false);
  const [displayProgress, setDisplayProgress] = useState<number>(() =>
    Math.max(6, Math.min(99, job.progress || 6))
  );
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);

  const isFailed = job.status === 'failed';
  const effectiveKeepPct = clampKeepPercentage(job.keep_percentage ?? keepPercentage);
  const sourceDurationSeconds =
    job.source_media_duration && job.source_media_duration > 0
      ? job.source_media_duration
      : video.duration;
  const computedTargetSeconds =
    sourceDurationSeconds > 0
      ? calculateTargetDuration(sourceDurationSeconds, 0.04, effectiveKeepPct).targetSeconds
      : job.target_duration;
  const compiledDurationSeconds =
    job.actual_output_duration && job.actual_output_duration > 0
      ? job.actual_output_duration
      : computedTargetSeconds;

  // Elapsed timer for live feedback
  useEffect(() => {
    if (isFailed) return;
    const timer = setInterval(() => {
      setElapsedSeconds((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [isFailed, job.id]);

  // Smooth client-side interpolation + creeping ceiling so the bar moves fluidly without stalling
  useEffect(() => {
    if (isFailed) return;

    const stageCeiling =
      job.status === 'rendering_video'
        ? 98
        : job.status === 'preparing_reel' || job.status === 'ranking_selecting'
        ? 89
        : job.status === 'identifying_moments' || job.status === 'checking_engagement'
        ? 80
        : 64;

    const ticker = setInterval(() => {
      setDisplayProgress((prev) => {
        const backendTarget = Math.max(6, Math.min(99, job.progress || 6));
        if (prev < backendTarget) {
          const step = Math.max(0.6, (backendTarget - prev) * 0.28);
          return Math.min(99, prev + step);
        }
        if (prev < stageCeiling) {
          const creep = prev < 50 ? 0.35 : prev < 85 ? 0.22 : 0.12;
          return Math.min(stageCeiling, prev + creep);
        }
        return prev;
      });
    }, 120);

    return () => clearInterval(ticker);
  }, [job.progress, job.status, isFailed]);

  const roundedProgress = Math.min(99, Math.max(5, Math.round(displayProgress)));

  return (
    <section
      aria-label="Compiling Highlight Video"
      className={`min-h-[calc(100vh-73px)] py-16 px-6 lg:px-12 ${
        darkMode ? 'theme-dark' : 'theme-light'
      }`}
    >
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center justify-between gap-4 mb-6">
          <button
            type="button"
            onClick={onCancel}
            className={`inline-flex items-center gap-2 text-xs font-medium hover:underline underline-offset-4 cursor-pointer ${
              darkMode
                ? 'text-[#94a3b8] hover:text-[#22d3ee]'
                : 'text-[#57534c] hover:text-[#141311]'
            }`}
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Back to Workspace</span>
          </button>

          <div className="flex items-center gap-3 font-mono text-xs tabular-nums">
            {!isFailed && (
              <span className={darkMode ? 'text-[#94a3b8]' : 'text-[#57534c]'}>
                {formatTimestamp(elapsedSeconds)} elapsed
              </span>
            )}
            <span aria-hidden="true" className={darkMode ? 'text-[#64748b]' : 'text-[#857f75]'}>
              ·
            </span>
            <span className={darkMode ? 'text-[#22d3ee]' : 'text-[#d9381e]'}>
              {isFailed ? 'Compilation Paused' : 'Compiling Video'}
            </span>
          </div>
        </div>

        <div
          className={`p-6 sm:p-8 rounded-lg border ${
            darkMode ? 'surface-card-dark' : 'surface-card-light'
          }`}
        >
          {/* Video Info */}
          <div className="flex flex-col sm:flex-row gap-5 items-start sm:items-center pb-6 border-b border-inherit">
            <div
              className={`w-full sm:w-44 aspect-video rounded overflow-hidden shrink-0 border ${
                darkMode
                  ? 'bg-[#05070a] border-[#1a2634]'
                  : 'bg-[#11100f] border-[#2c2926]'
              }`}
            >
              {!imgError && video.thumbnail ? (
                <img
                  src={video.thumbnail}
                  alt={video.title}
                  referrerPolicy="no-referrer"
                  onError={() => setImgError(true)}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <Film
                    className={`w-6 h-6 ${
                      darkMode ? 'text-[#22d3ee]' : 'text-[#a8a299]'
                    }`}
                  />
                </div>
              )}
            </div>

            <div className="flex-1 min-w-0">
              <div
                className={`flex flex-wrap items-center gap-2 text-xs font-mono tabular-nums mb-1.5 ${
                  darkMode ? 'text-[#94a3b8]' : 'text-[#57534c]'
                }`}
              >
                <span data-testid="compile-source-duration">
                  {formatTimestamp(sourceDurationSeconds)} source
                </span>
                <span aria-hidden="true">·</span>
                <span
                  data-testid="compile-target-duration"
                  className={`font-semibold ${
                    darkMode ? 'text-[#22d3ee]' : 'text-[#d9381e]'
                  }`}
                >
                  {formatTimestamp(compiledDurationSeconds)} compiled ({effectiveKeepPct}%)
                </span>
              </div>
              <h1 className="font-display text-lg sm:text-xl font-bold leading-snug truncate">
                {video.title}
              </h1>
            </div>
          </div>

          {/* Dynamic Progress Indicator */}
          <div className="mt-6">
            <div className="flex items-center justify-between gap-4 text-xs font-mono tabular-nums mb-2.5">
              <span className="inline-flex items-center gap-2 min-w-0">
                {!isFailed && (
                  <Loader2
                    className={`w-3.5 h-3.5 shrink-0 animate-spin ${
                      darkMode ? 'text-[#22d3ee]' : 'text-[#d9381e]'
                    }`}
                  />
                )}
                <span className="truncate">
                  {job.stage_message || 'Cutting and stitching HD video clips...'}
                </span>
              </span>
              <span
                className={`font-semibold shrink-0 text-sm ${
                  darkMode ? 'text-[#22d3ee]' : 'text-[#d9381e]'
                }`}
              >
                {roundedProgress}%
              </span>
            </div>

            <div
              className={`w-full h-2.5 rounded-full overflow-hidden relative ${
                darkMode ? 'bg-[#111922]' : 'bg-[#ebe6dc]'
              }`}
              role="progressbar"
              aria-valuenow={roundedProgress}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className={`h-full rounded-full transition-transform duration-150 origin-left ${
                  darkMode
                    ? 'bg-gradient-to-r from-[#0891b2] via-[#06b6d4] to-[#22d3ee]'
                    : 'bg-gradient-to-r from-[#b82d16] via-[#d9381e] to-[#ef4444]'
                }`}
                style={{
                  width: '100%',
                  transform: `scaleX(${Math.max(0.05, Math.min(1, displayProgress / 100))})`,
                }}
              />
            </div>

            {/* Live 4-Phase Compilation Checklist */}
            <div
              className={`mt-5 pt-5 border-t space-y-2.5 ${
                darkMode ? 'border-[#1a2634]' : 'border-[#dcd6ca]'
              }`}
            >
              {PIPELINE_PHASES.map((phase, idx) => {
                const prevThreshold = idx === 0 ? 0 : PIPELINE_PHASES[idx - 1].threshold;
                const isDone = roundedProgress >= phase.threshold;
                const isActive =
                  !isFailed && roundedProgress >= prevThreshold && roundedProgress < phase.threshold;

                return (
                  <div
                    key={phase.id}
                    className={`flex items-center justify-between gap-3 text-xs font-mono tabular-nums transition-opacity ${
                      isDone || isActive ? 'opacity-100' : 'opacity-50'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      {isDone ? (
                        <Check
                          className={`w-3.5 h-3.5 shrink-0 ${
                            darkMode ? 'text-[#22d3ee]' : 'text-[#16a34a]'
                          }`}
                        />
                      ) : isActive ? (
                        <Loader2
                          className={`w-3.5 h-3.5 shrink-0 animate-spin ${
                            darkMode ? 'text-[#22d3ee]' : 'text-[#d9381e]'
                          }`}
                        />
                      ) : (
                        <span
                          className={`w-3.5 h-3.5 shrink-0 inline-flex items-center justify-center ${
                            darkMode ? 'text-[#64748b]' : 'text-[#857f75]'
                          }`}
                        >
                          0{phase.id}
                        </span>
                      )}
                      <span
                        className={`truncate ${
                          isActive ? 'font-semibold' : ''
                        }`}
                      >
                        {phase.label}
                      </span>
                    </div>

                    <span
                      className={`shrink-0 ${
                        isDone
                          ? darkMode
                            ? 'text-[#22d3ee]'
                            : 'text-[#16a34a]'
                          : isActive
                          ? darkMode
                            ? 'text-[#ecfeff]'
                            : 'text-[#141311]'
                          : darkMode
                          ? 'text-[#64748b]'
                          : 'text-[#857f75]'
                      }`}
                    >
                      {isDone ? 'Done' : isActive ? 'Active' : 'Queued'}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {isFailed && (
            <div
              role="alert"
              className={`mt-6 p-4 rounded-md border ${
                darkMode
                  ? 'bg-cyan-950/60 border-cyan-800 text-cyan-100'
                  : 'bg-red-50 border-red-200 text-red-900'
              }`}
            >
              <div className="flex items-start gap-3">
                <AlertCircle
                  className={`w-5 h-5 shrink-0 mt-0.5 ${
                    darkMode ? 'text-[#22d3ee]' : 'text-[#d9381e]'
                  }`}
                />
                <div className="flex-1">
                  <h2 className="text-sm font-semibold mb-1">
                    Video Compilation Interrupted
                  </h2>
                  <p className="text-xs leading-relaxed mb-4">
                    {job.error || job.stage_message}
                  </p>
                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      onClick={() => void onRetry()}
                      className="btn-accent inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-md cursor-pointer"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>Try Again</span>
                    </button>
                    <button
                      type="button"
                      onClick={onCancel}
                      className={`px-4 py-2 text-xs font-medium rounded-md border transition-colors cursor-pointer ${
                        darkMode
                          ? 'border-[#1a2634] text-[#ecfeff] hover:bg-[#111922]'
                          : 'border-[#dcd6ca] text-[#141311] hover:bg-[#ebe6dc]'
                      }`}
                    >
                      Choose Another Video
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
};
