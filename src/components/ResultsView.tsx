import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import {
  Download,
  Play,
  ArrowLeft,
  AlertCircle,
  Loader2,
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

export const ResultsView: React.FC<ResultsViewProps> = ({
  darkMode,
  job,
  video,
  segments,
  onBackToWorkspace,
  onOpenAllReels,
  onDeleteJob,
}) => {
  const videoPlayerRef = useRef<HTMLVideoElement | null>(null);

  const [downloadingMp4, setDownloadingMp4] = useState<boolean>(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [activeSegmentIndex, setActiveSegmentIndex] = useState<number>(0);

  const isOwner = useMemo(() => {
    const clientId = getOrCreateClientId();
    const ownedSet = getOwnedJobIds();
    if (ownedSet.has(job.id)) return true;
    if (!job.owner_client_id) return true;
    return job.owner_client_id === clientId;
  }, [job.id, job.owner_client_id]);

  const encodedJobId = encodeURIComponent(job.id);
  const streamVersion = `${job.output_resolution_height || 720}-${Math.round(
    (job.actual_output_duration || 0) * 100
  )}`;
  const directMp4Url = `${window.location.origin}/api/highlights/${encodedJobId}/download`;
  const playbackMp4Url = `${directMp4Url}?v=${streamVersion}&clientId=${encodeURIComponent(getOrCreateClientId())}`;

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

  useEffect(() => {
    const el = videoPlayerRef.current;
    if (!el) return;
    el.muted = false;
    el.volume = 1.0;
    el.play().catch(() => {
      el.muted = true;
      void el.play().catch(() => {});
    });
  }, [job.id, playbackMp4Url]);

  const downloadFilename = useMemo(
    () => formatVideoDownloadFilename(video.title, video.youtube_video_id || job.id),
    [video.title, video.youtube_video_id, job.id]
  );

  const handleDownloadMp4 = async () => {
    setActionError(null);

    try {
      setDownloadingMp4(true);
      const downloadUrl = `/api/highlights/${encodedJobId}/download?download=1`;
      let mp4Blob: Blob;

      try {
        const res = await fetch(downloadUrl, {
          headers: getClientHeaders(),
        });
        if (!res.ok) {
          const errData = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(errData.error || 'Failed to download compiled MP4 video.');
        }
        const blob = await res.blob();
        mp4Blob = new Blob([blob], { type: 'video/mp4' });
      } catch (primaryErr) {
        // Fallback: fetch in 8 MB byte ranges to bypass Cloud Run's 32 MB single-response limit
        const chunkSize = 8 * 1024 * 1024;
        const chunks: BlobPart[] = [];
        let start = 0;
        let totalSize = Infinity;
        while (start < totalSize) {
          const end = Math.min(start + chunkSize - 1, Number.isFinite(totalSize) ? totalSize - 1 : start + chunkSize - 1);
          const rangeRes = await fetch(downloadUrl, {
            headers: {
              ...getClientHeaders(),
              Range: `bytes=${start}-${end}`,
            },
          });
          if (!rangeRes.ok && rangeRes.status !== 206) {
            throw primaryErr;
          }
          const contentRange = rangeRes.headers.get('Content-Range');
          const match = contentRange ? /bytes \d+-\d+\/(\d+)/.exec(contentRange) : null;
          if (match) {
            totalSize = parseInt(match[1], 10);
          }
          const buf = await rangeRes.arrayBuffer();
          if (buf.byteLength === 0) break;
          chunks.push(buf);
          start += buf.byteLength;
          if (!match || rangeRes.status === 200) break;
        }
        if (chunks.length === 0) throw primaryErr;
        mp4Blob = new Blob(chunks, { type: 'video/mp4' });
      }

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

      if (videoPlayerRef.current) {
        videoPlayerRef.current.currentTime = clamped;
        void videoPlayerRef.current.play().catch(() => {});
      }
    },
    [compiledTimeline]
  );

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

            {isOwner && (
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
            )}
          </div>
        </div>

        {job.analysis_mode === 'heuristic' && (
          <p role="status" className="mb-5 text-sm text-amber-700">
            Gemini was unavailable. These clips were selected using audio energy and timing; their content has not been analyzed by AI.
          </p>
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

        {/* Compiled Highlight Video Player (Shows ONLY the Compiled MP4 Video) */}
        <div
          className={`rounded-lg border overflow-hidden ${
            darkMode ? 'surface-card-dark' : 'surface-card-light'
          }`}
        >
          <div className="aspect-video w-full bg-black relative">
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
