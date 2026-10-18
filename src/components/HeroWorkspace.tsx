import React, { useRef } from 'react';
import {
  Play,
  Loader2,
  AlertCircle,
  Upload,
  ArrowUpRight,
} from 'lucide-react';
import {
  extractSharedReelJobId,
  MIN_KEEP_PERCENTAGE,
  MAX_KEEP_PERCENTAGE,
  DEFAULT_KEEP_PERCENTAGE,
  KEEP_PERCENTAGE_STEP,
} from '../lib/highlightEngine';

interface HeroWorkspaceProps {
  darkMode: boolean;
  urlInput: string;
  onUrlInputChange: (val: string) => void;
  keepPercentage: number;
  onKeepPercentageChange: (val: number) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  creatingJob: boolean;
  errorMsg: string | null;
  onGenerateHighlights: (
    targetUrl?: string,
    customDurationSeconds?: number,
    channelAccessToken?: string
  ) => Promise<void>;
  onUploadVideoFile: (file: File, optionalYoutubeUrl?: string) => Promise<void>;
}

const QUICK_SAMPLES = [
  {
    label: 'Sample 01 · Embedded Web Player',
    url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
  },
  {
    label: 'Sample 02 · YouTube Apps Showcase',
    url: 'https://www.youtube.com/watch?v=_OXtStBZyqs',
  },
];

export const HeroWorkspace: React.FC<HeroWorkspaceProps> = ({
  darkMode,
  urlInput,
  onUrlInputChange,
  keepPercentage,
  onKeepPercentageChange,
  inputRef,
  creatingJob,
  errorMsg,
  onGenerateHighlights,
  onUploadVideoFile,
}) => {
  const fileUploadRef = useRef<HTMLInputElement | null>(null);
  const isSharedReelInput = Boolean(extractSharedReelJobId(urlInput));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void onGenerateHighlights();
  };

  return (
    <section
      id="workspace"
      aria-label="Highlight Compiler Workspace"
      className={`py-12 lg:py-16 px-6 lg:px-12 border-b transition-colors ${
        darkMode
          ? 'bg-[#05070a] border-[#1a2634]'
          : 'bg-[#f5f2eb] border-[#dcd6ca]'
      }`}
    >
      <div className="max-w-[1120px] mx-auto">
        <div className="max-w-3xl">
          <h1
            className="font-display font-bold tracking-tight leading-[1.06] text-balance mb-5"
            style={{ fontSize: 'clamp(2.5rem, 4.5vw, 4.25rem)' }}
          >
            Cut long videos down to the moments worth watching.
          </h1>

          <p
            className={`text-base sm:text-lg leading-relaxed max-w-2xl mb-10 ${
              darkMode ? 'text-[#94a3b8]' : 'text-[#57534c]'
            }`}
          >
            Paste a YouTube link or drop a local video file. Highlight extracts the strongest clips
            with original audio and stitches them into a ready-to-download MP4.
          </p>
        </div>

        <div
          className={`p-6 sm:p-8 rounded-lg border ${
            darkMode ? 'surface-card-dark' : 'surface-card-light'
          }`}
        >
          <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-3">
            <label htmlFor="youtube-url-input" className="sr-only">
              YouTube Video URL
            </label>
            <input
              ref={inputRef}
              id="youtube-url-input"
              type="text"
              value={urlInput}
              onChange={(e) => onUrlInputChange(e.target.value)}
              onPaste={(e) => {
                const pasted = e.clipboardData.getData('text').trim();
                if (extractSharedReelJobId(pasted)) {
                  e.preventDefault();
                  onUrlInputChange(pasted);
                  void onGenerateHighlights(pasted);
                }
              }}
              placeholder="https://www.youtube.com/watch?v=..."
              className={`flex-1 min-w-0 px-4 py-3.5 text-sm sm:text-base rounded-md border font-mono transition-colors focus:outline-none focus:ring-2 ${
                darkMode
                  ? 'bg-[#05070a] border-[#1a2634] text-[#ecfeff] placeholder-[#64748b] focus:ring-[#22d3ee]'
                  : 'bg-[#f5f2eb] border-[#dcd6ca] text-[#141311] placeholder-[#857f75] focus:ring-[#d9381e]'
              }`}
            />

            <button
              type="submit"
              disabled={creatingJob}
              className="btn-accent inline-flex items-center justify-center gap-2 px-6 py-3.5 text-sm font-semibold rounded-md cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-50"
            >
              {creatingJob ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Play className="w-4 h-4 fill-current" />
              )}
              <span>
                {creatingJob
                  ? 'Compiling...'
                  : isSharedReelInput
                  ? 'Open Compiled Video'
                  : 'Compile Video'}
              </span>
            </button>
          </form>

          {/* Percentage of Video Kept Slider (5% to 50%, step 5, Default 20%) */}
          <div
            className={`mt-5 pt-5 border-t ${
              darkMode ? 'border-[#1a2634]' : 'border-[#dcd6ca]'
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5">
              <label
                htmlFor="keep-percentage-slider"
                className="text-xs sm:text-sm font-medium"
              >
                Percentage of Video Kept
              </label>

              <div className="flex items-center gap-2.5 text-xs font-mono tabular-nums">
                <span
                  data-testid="keep-percentage-value"
                  className={`font-semibold ${
                    darkMode ? 'text-[#22d3ee]' : 'text-[#d9381e]'
                  }`}
                >
                  {keepPercentage}% of video length
                </span>
                {keepPercentage !== DEFAULT_KEEP_PERCENTAGE && (
                  <>
                    <span
                      aria-hidden="true"
                      className={darkMode ? 'text-[#64748b]' : 'text-[#857f75]'}
                    >
                      ·
                    </span>
                    <button
                      type="button"
                      onClick={() => onKeepPercentageChange(DEFAULT_KEEP_PERCENTAGE)}
                      className={`underline underline-offset-4 cursor-pointer whitespace-nowrap shrink-0 ${
                        darkMode
                          ? 'text-[#94a3b8] hover:text-[#22d3ee]'
                          : 'text-[#57534c] hover:text-[#141311]'
                      }`}
                    >
                      Reset to 20%
                    </button>
                  </>
                )}
              </div>
            </div>

            <input
              id="keep-percentage-slider"
              data-testid="keep-percentage-slider"
              type="range"
              min={MIN_KEEP_PERCENTAGE}
              max={MAX_KEEP_PERCENTAGE}
              step={KEEP_PERCENTAGE_STEP}
              value={keepPercentage}
              disabled={creatingJob}
              onChange={(e) => onKeepPercentageChange(Number(e.target.value))}
              aria-label="Percentage of Video Kept"
              aria-valuemin={MIN_KEEP_PERCENTAGE}
              aria-valuemax={MAX_KEEP_PERCENTAGE}
              aria-valuenow={keepPercentage}
              aria-valuetext={`${keepPercentage}% of video length`}
              className={`w-full h-2 rounded-lg appearance-none cursor-pointer ${
                darkMode
                  ? 'bg-[#111922] accent-[#22d3ee]'
                  : 'bg-[#dcd6ca] accent-[#d9381e]'
              }`}
            />

            <div
              className={`relative mt-1.5 flex items-center justify-between text-xs font-mono tabular-nums ${
                darkMode ? 'text-[#94a3b8]' : 'text-[#57534c]'
              }`}
            >
              <span>{MIN_KEEP_PERCENTAGE}%</span>
              <button
                type="button"
                onClick={() => onKeepPercentageChange(DEFAULT_KEEP_PERCENTAGE)}
                style={{ left: '33.333%' }}
                className="absolute -translate-x-1/2 cursor-pointer hover:underline underline-offset-4 whitespace-nowrap shrink-0"
              >
                {DEFAULT_KEEP_PERCENTAGE}% (Default)
              </button>
              <span>{MAX_KEEP_PERCENTAGE}%</span>
            </div>
          </div>

          {/* Secondary Action Strip: Upload Local File + Quick Samples */}
          <div
            className={`mt-5 pt-5 border-t flex flex-col sm:flex-row sm:items-center justify-between gap-4 text-xs ${
              darkMode
                ? 'border-[#1a2634] text-[#94a3b8]'
                : 'border-[#dcd6ca] text-[#57534c]'
            }`}
          >
            <div className="flex items-center gap-3">
              <input
                ref={fileUploadRef}
                id="hero-video-upload"
                type="file"
                accept="video/mp4,video/quicktime,video/webm,video/x-matroska,.mp4,.mov,.webm,.mkv"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    void onUploadVideoFile(file, urlInput);
                  }
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                disabled={creatingJob}
                onClick={() => fileUploadRef.current?.click()}
                className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-md border font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                  darkMode
                    ? 'bg-[#111922] border-[#1a2634] text-[#ecfeff] hover:bg-[#1a2634] hover:border-[#22d3ee]/50'
                    : 'bg-[#ebe6dc] border-[#dcd6ca] text-[#141311] hover:bg-[#dfd9cc]'
                }`}
              >
                <Upload className="w-3.5 h-3.5" />
                <span>Upload Local Video (.MP4 / .MOV)</span>
              </button>
              <span className="hidden md:inline">
                Stitches real video &amp; audio directly on the server
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <span className="font-mono">Try sample:</span>
              {QUICK_SAMPLES.map((sample) => (
                <button
                  key={sample.url}
                  type="button"
                  disabled={creatingJob}
                  onClick={() => {
                    onUrlInputChange(sample.url);
                    void onGenerateHighlights(sample.url);
                  }}
                  className={`inline-flex items-center gap-1 font-medium underline underline-offset-4 transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                    darkMode
                      ? 'text-[#ecfeff] hover:text-[#22d3ee]'
                      : 'text-[#141311] hover:text-[#d9381e]'
                  }`}
                >
                  <span>{sample.label}</span>
                  <ArrowUpRight className="w-3 h-3" />
                </button>
              ))}
            </div>
          </div>

          {errorMsg && (
            <div
              role="alert"
              className={`mt-5 p-3.5 rounded-md border flex items-start gap-2.5 text-xs sm:text-sm ${
                darkMode
                  ? 'bg-cyan-950/60 border-cyan-700/80 text-cyan-100'
                  : 'bg-red-50 border-red-200 text-red-900'
              }`}
            >
              <AlertCircle
                className={`w-4 h-4 shrink-0 mt-0.5 ${
                  darkMode ? 'text-[#22d3ee]' : 'text-[#d9381e]'
                }`}
              />
              <span>{errorMsg}</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
};
