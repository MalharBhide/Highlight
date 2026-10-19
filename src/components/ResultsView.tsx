import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import {
  Download,
  Upload,
  Play,
  ArrowLeft,
  AlertCircle,
  Loader2,
  Share2,
  Check,
  Copy,
  ExternalLink,
  Trash2,
} from 'lucide-react';
import {
  formatTimestamp,
  classifySegmentRole,
  formatVideoDownloadFilename,
  type HighlightJobRecord,
  type HighlightSegmentRecord,
  type VideoRecord,
} from '../lib/highlightEngine';
import {
  getClientHeaders,
  getOrCreateClientId,
  getOwnedJobIds,
} from '../lib/clientSession';

declare global {
  interface Window {
    YT?: {
      Player: new (
        element: HTMLElement | string,
        options: {
          videoId: string;
          width?: string | number;
          height?: string | number;
          playerVars?: Record<string, string | number>;
          events?: {
            onReady?: (event: { target: YTPlayerInstance }) => void;
            onStateChange?: (event: { data: number; target: YTPlayerInstance }) => void;
            onError?: (event: { data: number }) => void;
          };
        }
      ) => YTPlayerInstance;
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

interface YTPlayerInstance {
  playVideo: () => void;
  pauseVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  getCurrentTime: () => number;
  getPlayerState: () => number;
  mute: () => void;
  unMute: () => void;
  isMuted: () => boolean;
  setVolume?: (volume: number) => void;
  destroy: () => void;
}

interface ResultsViewProps {
  darkMode: boolean;
  job: HighlightJobRecord & { download_ready?: boolean };
  video: VideoRecord;
  segments: HighlightSegmentRecord[];
  onBackToWorkspace: () => void;
  onOpenAllReels: () => void;
  onRefreshJob: () => Promise<void>;
  onDeleteJob?: () => void;
}

function formatRoleLabel(seg: HighlightSegmentRecord, duration: number): string {
  const role = seg.role || classifySegmentRole(seg, duration);
  if (role === 'intro') return 'Intro';
  if (role === 'outro') return 'Outro';
  return 'Best Moment';
}

function copyTextSynchronously(text: string): boolean {
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '0';
    textarea.style.left = '0';
    textarea.style.width = '1px';
    textarea.style.height = '1px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

export const ResultsView: React.FC<ResultsViewProps> = ({
  darkMode,
  job,
  video,
  segments,
  onBackToWorkspace,
  onOpenAllReels,
  onRefreshJob,
  onDeleteJob,
}) => {
  const videoPlayerRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const ytContainerRef = useRef<HTMLDivElement | null>(null);
  const ytPlayerRef = useRef<YTPlayerInstance | null>(null);
  const shareInputRef = useRef<HTMLInputElement | null>(null);

  const [uploadingOrRendering, setUploadingOrRendering] = useState<boolean>(false);
  const [downloadingMp4, setDownloadingMp4] = useState<boolean>(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copiedShareLink, setCopiedShareLink] = useState<boolean>(false);
  const [showSharePanel, setShowSharePanel] = useState<boolean>(false);
  const copyResetTimerRef = useRef<number | null>(null);

  const [activeSegmentIndex, setActiveSegmentIndex] = useState<number>(0);
  const [ytReady, setYtReady] = useState<boolean>(false);

  const isMp4Ready = Boolean(job.download_ready && job.source_media_status === 'rendered');
  const isOwner = useMemo(() => {
    const clientId = getOrCreateClientId();
    const ownedSet = getOwnedJobIds();
    if (ownedSet.has(job.id)) return true;
    if (!job.owner_client_id) return true;
    return job.owner_client_id === clientId;
  }, [job.id, job.owner_client_id]);

  const encodedJobId = encodeURIComponent(job.id);
  const shareUrl = `${window.location.origin}/?reel=${encodedJobId}#reel=${encodedJobId}`;
  const streamVersion = `${job.output_resolution_height || 720}-${Math.round(
    (job.actual_output_duration || 0) * 100
  )}`;
  const directMp4Url = `${window.location.origin}/api/highlights/${encodedJobId}/download`;
  const playbackMp4Url = `${directMp4Url}?v=${streamVersion}`;

  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
    };
  }, []);

  const handleShareReel = () => {
    setActionError(null);
    setShowSharePanel(true);

    // Run synchronous execCommand copy immediately during the active user click gesture
    const syncCopied = copyTextSynchronously(shareUrl);

    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      void navigator.clipboard.writeText(shareUrl).catch(() => {});
    }

    setCopiedShareLink(true);
    if (copyResetTimerRef.current !== null) {
      window.clearTimeout(copyResetTimerRef.current);
    }
    copyResetTimerRef.current = window.setTimeout(() => {
      setCopiedShareLink(false);
    }, 2500);

    if (!syncCopied) {
      setTimeout(() => {
        shareInputRef.current?.focus();
        shareInputRef.current?.select();
      }, 40);
    }
  };

  const compiledTimeline = useMemo(() => {
    let offset = 0;
    const ordered = [...segments].sort((a, b) => a.sequence_order - b.sequence_order);
    const items = ordered.map((seg, idx) => {
      const duration = Math.max(0.01, seg.end_time - seg.start_time);
      const item = {
        index: idx,
        segment: seg,
        roleLabel: formatRoleLabel(seg, video.duration),
        duration,
        compiledStart: offset,
        compiledEnd: offset + duration,
      };
      offset += duration;
      return item;
    });
    return {
      items,
      totalDuration: Math.max(0.01, offset),
    };
  }, [segments, video.duration]);

  const activeSegmentIndexRef = useRef<number>(activeSegmentIndex);
  activeSegmentIndexRef.current = activeSegmentIndex;
  const segmentsRef = useRef<HighlightSegmentRecord[]>(segments);
  segmentsRef.current = segments;

  useEffect(() => {
    const el = videoPlayerRef.current;
    if (!el || !isMp4Ready) return;
    el.muted = false;
    el.volume = 1.0;
    el.play().catch(() => {
      // Fallback to muted autoplay when opening a shared link in a new tab without prior user interaction
      el.muted = true;
      void el.play().catch(() => {});
    });
  }, [isMp4Ready, job.id]);

  const downloadFilename = useMemo(
    () => formatVideoDownloadFilename(video.title, video.youtube_video_id || job.id),
    [video.title, video.youtube_video_id, job.id]
  );

  const handleDownloadMp4 = async () => {
    setActionError(null);

    try {
      setDownloadingMp4(true);
      const res = await fetch(`/api/highlights/${encodedJobId}/download?download=1`, {
        headers: getClientHeaders(),
      });
      if (!res.ok) {
        const errData = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errData.error || 'Failed to download compiled MP4 video.');
      }
      const blob = await res.blob();
      const mp4Blob = new Blob([blob], { type: 'video/mp4' });
      const targetUrl = URL.createObjectURL(mp4Blob);

      const a = document.createElement('a');
      a.href = targetUrl;
      a.download = downloadFilename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      setTimeout(() => URL.revokeObjectURL(targetUrl), 10000);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to download video.');
    } finally {
      setDownloadingMp4(false);
    }
  };

  const seekToCompiledSecond = useCallback(
    (targetCompiledSec: number) => {
      const clamped = Math.max(0, Math.min(compiledTimeline.totalDuration - 0.1, targetCompiledSec));
      const found =
        compiledTimeline.items.find(
          (it) => clamped >= it.compiledStart && clamped <= it.compiledEnd
        ) || compiledTimeline.items[0];
      if (!found) return;

      setActiveSegmentIndex(found.index);
      activeSegmentIndexRef.current = found.index;

      if (isMp4Ready && videoPlayerRef.current) {
        videoPlayerRef.current.currentTime = clamped;
        void videoPlayerRef.current.play().catch(() => {});
      } else if (ytPlayerRef.current && ytReady) {
        const offsetInsideClip = Math.max(0, clamped - found.compiledStart);
        ytPlayerRef.current.seekTo(found.segment.start_time + offsetInsideClip, true);
        ytPlayerRef.current.playVideo();
      }
    },
    [compiledTimeline, isMp4Ready, ytReady]
  );

  useEffect(() => {
    if (isMp4Ready || video.is_fixture || !video.youtube_video_id) {
      return;
    }

    let isCancelled = false;
    const host = ytContainerRef.current;

    const initPlayer = () => {
      if (isCancelled || !host || !window.YT?.Player) return;

      try {
        if (ytPlayerRef.current) {
          ytPlayerRef.current.destroy();
          ytPlayerRef.current = null;
        }
      } catch {
        // ignore cleanup
      }

      host.innerHTML = '';
      const mountEl = document.createElement('div');
      mountEl.style.width = '100%';
      mountEl.style.height = '100%';
      host.appendChild(mountEl);

      const firstStart = Math.floor(segmentsRef.current[0]?.start_time || 0);
      ytPlayerRef.current = new window.YT.Player(mountEl, {
        videoId: video.youtube_video_id,
        width: '100%',
        height: '100%',
        playerVars: {
          autoplay: 1,
          controls: 1,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          start: firstStart,
          origin: window.location.origin,
        },
        events: {
          onReady: (event) => {
            if (isCancelled) return;
            setYtReady(true);
            event.target.unMute();
            if (typeof event.target.setVolume === 'function') {
              event.target.setVolume(100);
            }
            const startSec = segmentsRef.current[0]?.start_time || 0;
            event.target.seekTo(startSec, true);
            event.target.playVideo();
          },
        },
      });
    };

    if (window.YT?.Player) {
      initPlayer();
    } else {
      const existingScript = document.querySelector(
        'script[src="https://www.youtube.com/iframe_api"]'
      );
      const prevCallback = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        if (prevCallback) prevCallback();
        initPlayer();
      };
      if (!existingScript) {
        const tag = document.createElement('script');
        tag.src = 'https://www.youtube.com/iframe_api';
        document.head.appendChild(tag);
      }
    }

    return () => {
      isCancelled = true;
      try {
        if (ytPlayerRef.current) {
          ytPlayerRef.current.destroy();
          ytPlayerRef.current = null;
        }
      } catch {
        // ignore
      }
      if (host) {
        host.innerHTML = '';
      }
    };
  }, [isMp4Ready, video.is_fixture, video.youtube_video_id]);

  useEffect(() => {
    if (isMp4Ready || !ytReady || !ytPlayerRef.current || segments.length === 0) return;

    const timer = setInterval(() => {
      const player = ytPlayerRef.current;
      if (!player || typeof player.getCurrentTime !== 'function') return;

      try {
        const state = player.getPlayerState();
        if (state !== 1) return;

        const rawTime = player.getCurrentTime();
        const currIdx = activeSegmentIndexRef.current;
        const currItem = compiledTimeline.items[currIdx];
        if (!currItem) return;

        const { segment } = currItem;

        if (rawTime >= segment.end_time - 0.15) {
          if (currIdx < compiledTimeline.items.length - 1) {
            const nextIdx = currIdx + 1;
            const nextItem = compiledTimeline.items[nextIdx];
            activeSegmentIndexRef.current = nextIdx;
            setActiveSegmentIndex(nextIdx);
            player.seekTo(nextItem.segment.start_time, true);
            player.playVideo();
          } else {
            player.pauseVideo();
          }
          return;
        }

        if (rawTime < segment.start_time - 1.5) {
          player.seekTo(segment.start_time, true);
        }
      } catch {
        // ignore transient player read errors
      }
    }, 120);

    return () => clearInterval(timer);
  }, [isMp4Ready, ytReady, segments, compiledTimeline]);

  const handleAutoUploadAndCompile = async (file: File) => {
    setActionError(null);

    try {
      setUploadingOrRendering(true);
      const formData = new FormData();
      formData.append('file', file);
      formData.append('rightsConfirmed', 'true');
      formData.append('syncDuration', 'true');

      const sourceRes = await fetch(`/api/highlights/${job.id}/source`, {
        method: 'POST',
        headers: getClientHeaders(),
        body: formData,
      });
      const sourceData = (await sourceRes.json()) as { error?: string };
      if (!sourceRes.ok) {
        throw new Error(sourceData.error || 'Failed to upload video file.');
      }

      const renderRes = await fetch(`/api/highlights/${job.id}/render`, {
        method: 'POST',
        headers: getClientHeaders(),
      });
      const renderData = (await renderRes.json()) as { error?: string };
      if (!renderRes.ok) {
        throw new Error(renderData.error || 'Failed to compile MP4 highlight video.');
      }

      await onRefreshJob();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to compile highlight video.');
    } finally {
      setUploadingOrRendering(false);
    }
  };

  return (
    <section
      aria-label="Compiled Highlight Video"
      className={`min-h-[calc(100vh-73px)] py-10 px-6 lg:px-12 ${
        darkMode ? 'theme-dark' : 'theme-light'
      }`}
    >
      <div className="max-w-[1040px] mx-auto">
        {/* Top Bar: Navigation + Video Title + Download Action */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div className="min-w-0">
            <div className="flex items-center gap-3 text-xs font-medium mb-1.5">
              <button
                type="button"
                onClick={onBackToWorkspace}
                className={`inline-flex items-center gap-1.5 hover:underline underline-offset-4 cursor-pointer ${
                  darkMode
                    ? 'text-[#94a3b8] hover:text-[#22d3ee]'
                    : 'text-[#57534c] hover:text-[#141311]'
                }`}
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>Back to Workspace</span>
              </button>
              <span aria-hidden="true" className={darkMode ? 'text-[#64748b]' : 'text-[#857f75]'}>
                ·
              </span>
              <button
                type="button"
                onClick={onOpenAllReels}
                className={`hover:underline underline-offset-4 cursor-pointer ${
                  darkMode
                    ? 'text-[#94a3b8] hover:text-[#22d3ee]'
                    : 'text-[#57534c] hover:text-[#141311]'
                }`}
              >
                All Reels
              </button>
            </div>
            <h1 className="font-display text-xl sm:text-2xl font-bold tracking-tight truncate">
              {video.title}
            </h1>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={() => void handleShareReel()}
              data-testid="share-reel-button"
              className={`inline-flex items-center gap-2 px-4 py-2.5 text-xs sm:text-sm font-semibold rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                darkMode
                  ? 'bg-[#0b0f14] border-[#1a2634] text-[#ecfeff] hover:bg-[#111922] hover:border-[#22d3ee]/50'
                  : 'bg-white border-[#dcd6ca] text-[#141311] hover:bg-[#ebe6dc]'
              }`}
            >
              {copiedShareLink ? (
                <>
                  <Check
                    className={`w-4 h-4 ${darkMode ? 'text-[#22d3ee]' : 'text-[#d9381e]'}`}
                  />
                  <span>Link Copied</span>
                </>
              ) : (
                <>
                  <Share2 className="w-4 h-4" />
                  <span>Share</span>
                </>
              )}
            </button>

            {isOwner && onDeleteJob && (
              <button
                type="button"
                onClick={onDeleteJob}
                title="Delete this compiled video"
                className={`inline-flex items-center gap-1.5 px-3.5 py-2.5 text-xs sm:text-sm font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  darkMode
                    ? 'bg-[#0b0f14] border-[#1a2634] text-[#94a3b8] hover:text-[#ecfeff] hover:border-[#22d3ee]/50'
                    : 'bg-white border-[#dcd6ca] text-[#57534c] hover:text-[#141311] hover:bg-[#ebe6dc]'
                }`}
              >
                <Trash2 className="w-4 h-4" />
                <span className="hidden sm:inline">Delete</span>
              </button>
            )}

            <input
              ref={fileInputRef}
              id="source-video-upload"
              type="file"
              accept="video/mp4,video/quicktime,video/webm,video/x-matroska,.mp4,.mov,.webm,.mkv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  void handleAutoUploadAndCompile(file);
                }
                e.target.value = '';
              }}
            />

            {isOwner && (
              isMp4Ready ? (
                <button
                  type="button"
                  data-testid="download-mp4-button"
                  data-download-filename={downloadFilename}
                  disabled={downloadingMp4}
                  onClick={() => void handleDownloadMp4()}
                  className="btn-accent inline-flex items-center gap-2 px-5 py-2.5 text-xs sm:text-sm font-semibold rounded-md whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                >
                  {downloadingMp4 ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Download className="w-4 h-4" />
                  )}
                  <span>{downloadingMp4 ? 'Downloading...' : 'Download Video (.MP4)'}</span>
                </button>
              ) : (
                <button
                  type="button"
                  disabled={uploadingOrRendering}
                  onClick={() => fileInputRef.current?.click()}
                  className="btn-accent inline-flex items-center gap-2 px-5 py-2.5 text-xs sm:text-sm font-semibold rounded-md cursor-pointer disabled:opacity-50"
                >
                  {uploadingOrRendering ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Upload className="w-4 h-4" />
                  )}
                  <span>{uploadingOrRendering ? 'Compiling Video...' : 'Compile .MP4 from File'}</span>
                </button>
              )
            )}
          </div>
        </div>

        {showSharePanel && (
          <div
            data-testid="share-reel-panel"
            className={`mb-5 p-4 rounded-lg border flex flex-col gap-3 ${
              darkMode ? 'surface-card-dark' : 'surface-card-light'
            }`}
          >
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs sm:text-sm font-semibold">
                <Check
                  className={`w-4 h-4 shrink-0 ${
                    darkMode ? 'text-[#22d3ee]' : 'text-[#d9381e]'
                  }`}
                />
                <span>Direct link to this compiled highlight reel</span>
              </div>
              <div className="flex items-center gap-3 text-xs font-medium">
                <a
                  href={shareUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="open-shared-reel-link"
                  className={`inline-flex items-center gap-1 hover:underline underline-offset-4 ${
                    darkMode ? 'text-[#22d3ee]' : 'text-[#d9381e]'
                  }`}
                >
                  <span>Open Shared Reel</span>
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
                {isMp4Ready && (
                  <>
                    <span aria-hidden="true" className={darkMode ? 'text-[#64748b]' : 'text-[#857f75]'}>
                      ·
                    </span>
                    <a
                      href={directMp4Url}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-testid="open-direct-mp4-link"
                      className={`inline-flex items-center gap-1 hover:underline underline-offset-4 ${
                        darkMode
                          ? 'text-[#94a3b8] hover:text-[#ecfeff]'
                          : 'text-[#57534c] hover:text-[#141311]'
                      }`}
                    >
                      <span>Direct MP4 Stream</span>
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  </>
                )}
              </div>
            </div>

            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
              <label htmlFor="share-reel-url-input" className="sr-only">
                Shareable Highlight Reel Link
              </label>
              <input
                ref={shareInputRef}
                id="share-reel-url-input"
                data-testid="share-url-input"
                type="text"
                readOnly
                value={shareUrl}
                onFocus={(e) => e.currentTarget.select()}
                onClick={(e) => e.currentTarget.select()}
                className={`flex-1 min-w-0 px-3.5 py-2 text-xs sm:text-sm font-mono rounded-md border focus:outline-none focus:ring-2 ${
                  darkMode
                    ? 'bg-[#05070a] border-[#1a2634] text-[#ecfeff] focus:ring-[#22d3ee]'
                    : 'bg-[#f5f2eb] border-[#dcd6ca] text-[#141311] focus:ring-[#d9381e]'
                }`}
              />
              <button
                type="button"
                data-testid="copy-share-url-button"
                onClick={() => void handleShareReel()}
                className="btn-accent inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-md cursor-pointer whitespace-nowrap shrink-0"
              >
                {copiedShareLink ? (
                  <>
                    <Check className="w-3.5 h-3.5" />
                    <span>Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>Copy Link</span>
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {actionError && (
          <div
            role="alert"
            className={`mb-5 p-3.5 rounded-md border flex items-start gap-2.5 text-xs sm:text-sm ${
              darkMode
                ? 'bg-cyan-950/60 border-cyan-800 text-cyan-100'
                : 'bg-red-50 border-red-200 text-red-800'
            }`}
          >
            <AlertCircle
              className={`w-4 h-4 shrink-0 mt-0.5 ${
                darkMode ? 'text-[#22d3ee]' : 'text-[#d9381e]'
              }`}
            />
            <span>{actionError}</span>
          </div>
        )}

        {/* Compiled Highlight Video Player (Native Video Controls Only) */}
        <div
          className={`rounded-lg border overflow-hidden ${
            darkMode ? 'surface-card-dark' : 'surface-card-light'
          }`}
        >
          <div className="aspect-video w-full bg-black relative">
            {isMp4Ready ? (
              <video
                key={playbackMp4Url}
                ref={videoPlayerRef}
                data-testid="rendered-mp4-player"
                src={playbackMp4Url}
                controls
                controlsList={isOwner ? undefined : 'nodownload'}
                autoPlay
                playsInline
                preload="auto"
                onTimeUpdate={(e) => {
                  const t = e.currentTarget.currentTime;
                  const found = compiledTimeline.items.find(
                    (it) => t >= it.compiledStart && t <= it.compiledEnd
                  );
                  if (found && found.index !== activeSegmentIndexRef.current) {
                    activeSegmentIndexRef.current = found.index;
                    setActiveSegmentIndex(found.index);
                  }
                }}
                className="w-full h-full object-contain bg-black"
              >
                Your browser does not support HTML5 video playback.
              </video>
            ) : (
              <div
                data-testid="compiled-youtube-player"
                className="w-full h-full relative bg-black"
              >
                <div ref={ytContainerRef} className="w-full h-full" />
              </div>
            )}
          </div>
        </div>

        {/* Compiled Timestamps Workspace Beneath the Video */}
        {compiledTimeline.items.length > 0 && (
          <div
            data-testid="compiled-timestamps-section"
            className={`mt-6 rounded-lg border overflow-hidden ${
              darkMode ? 'surface-card-dark' : 'surface-card-light'
            }`}
          >
            <div
              className={`px-5 py-4 border-b flex flex-wrap items-center justify-between gap-4 ${
                darkMode ? 'border-[#1a2634]' : 'border-[#dcd6ca]'
              }`}
            >
              <div>
                <h2 className="font-display text-base sm:text-lg font-bold tracking-tight">
                  Compiled Timestamps
                </h2>
                <p
                  className={`text-xs mt-0.5 ${
                    darkMode ? 'text-[#94a3b8]' : 'text-[#57534c]'
                  }`}
                >
                  Select any timestamp below to jump directly to that clip in the compiled video.
                </p>
              </div>

              <div
                className={`font-mono text-xs tabular-nums ${
                  darkMode ? 'text-[#94a3b8]' : 'text-[#57534c]'
                }`}
              >
                <span>{compiledTimeline.items.length} clips</span>
                <span aria-hidden="true"> · </span>
                <span>
                  {formatTimestamp(video.duration)} source →{' '}
                  {formatTimestamp(job.actual_output_duration || compiledTimeline.totalDuration)} reel
                </span>
              </div>
            </div>

            <div
              className={`divide-y ${
                darkMode ? 'divide-[#1a2634]' : 'divide-[#dcd6ca]'
              }`}
            >
              {compiledTimeline.items.map((item) => {
                const isActive = item.index === activeSegmentIndex;
                return (
                  <button
                    key={item.segment.id || item.index}
                    type="button"
                    onClick={() => seekToCompiledSecond(item.compiledStart)}
                    className={`w-full text-left px-5 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition-colors cursor-pointer ${
                      isActive
                        ? darkMode
                          ? 'bg-[#111922]'
                          : 'bg-[#ebe6dc]/75'
                        : darkMode
                        ? 'hover:bg-[#111922]/60'
                        : 'hover:bg-[#f5f2eb]/70'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-xs font-mono tabular-nums mb-1">
                        <span
                          className={`font-bold ${
                            darkMode ? 'text-[#22d3ee]' : 'text-[#d9381e]'
                          }`}
                        >
                          {String(item.index + 1).padStart(2, '0')}.
                        </span>
                        <span
                          className={`font-semibold ${
                            darkMode ? 'text-[#22d3ee]' : 'text-[#d9381e]'
                          }`}
                        >
                          {item.roleLabel}
                        </span>
                        <span
                          aria-hidden="true"
                          className={darkMode ? 'text-[#64748b]' : 'text-[#857f75]'}
                        >
                          ·
                        </span>
                        <span className="font-semibold">
                          Source {formatTimestamp(item.segment.start_time)} –{' '}
                          {formatTimestamp(item.segment.end_time)}
                        </span>
                        <span
                          aria-hidden="true"
                          className={darkMode ? 'text-[#64748b]' : 'text-[#857f75]'}
                        >
                          ·
                        </span>
                        <span className={darkMode ? 'text-[#94a3b8]' : 'text-[#57534c]'}>
                          Reel {formatTimestamp(item.compiledStart)} –{' '}
                          {formatTimestamp(item.compiledEnd)}
                        </span>
                      </div>

                      <div className="font-display text-sm sm:text-base font-bold truncate">
                        {item.segment.title}
                      </div>
                      {item.segment.description && (
                        <p
                          className={`text-xs mt-0.5 line-clamp-1 ${
                            darkMode ? 'text-[#94a3b8]' : 'text-[#57534c]'
                          }`}
                        >
                          {item.segment.description}
                        </p>
                      )}
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <span
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-mono tabular-nums font-semibold ${
                          isActive
                            ? darkMode
                              ? 'bg-[#06b6d4] text-[#030712]'
                              : 'bg-[#d9381e] text-white'
                            : darkMode
                            ? 'bg-[#05070a] border border-[#1a2634] text-[#ecfeff]'
                            : 'bg-[#f5f2eb] border border-[#dcd6ca] text-[#141311]'
                        }`}
                      >
                        <Play className="w-3 h-3 fill-current" />
                        <span>
                          {formatTimestamp(item.segment.start_time)} –{' '}
                          {formatTimestamp(item.segment.end_time)}
                        </span>
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </section>
  );
};
