import React, { useState } from 'react';
import {
  Loader2,
  AlertCircle,
  RotateCcw,
  ArrowLeft,
  Film,
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

export const ProcessingView: React.FC<ProcessingViewProps> = ({
  darkMode,
  job,
  video,
  keepPercentage,
  onRetry,
  onCancel,
}) => {
  const [imgError, setImgError] = useState(false);
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

          <span
            className={`font-mono text-xs tabular-nums ${
              darkMode ? 'text-[#22d3ee]' : 'text-[#d9381e]'
            }`}
          >
            {isFailed ? 'Compilation Paused' : 'Compiling Video'}
          </span>
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

          {/* Single Focused Progress Indicator */}
          <div className="mt-6">
            <div className="flex items-center justify-between text-xs font-mono tabular-nums mb-2.5">
              <span className="inline-flex items-center gap-2">
                {!isFailed && (
                  <Loader2
                    className={`w-3.5 h-3.5 animate-spin ${
                      darkMode ? 'text-[#22d3ee]' : 'text-[#d9381e]'
                    }`}
                  />
                )}
                <span>{job.stage_message || 'Cutting and stitching video clips...'}</span>
              </span>
              <span
                className={`font-semibold ${
                  darkMode ? 'text-[#22d3ee]' : 'text-[#d9381e]'
                }`}
              >
                {job.progress}%
              </span>
            </div>
            <div
              className={`w-full h-2 rounded-full overflow-hidden ${
                darkMode ? 'bg-[#111922]' : 'bg-[#ebe6dc]'
              }`}
              role="progressbar"
              aria-valuenow={job.progress}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className={`h-full transition-all duration-300 ${
                  darkMode ? 'bg-[#06b6d4]' : 'bg-[#d9381e]'
                }`}
                style={{ width: `${Math.max(5, Math.min(100, job.progress))}%` }}
              />
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
