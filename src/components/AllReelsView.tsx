import React, { useState, useMemo } from 'react';
import {
  Play,
  ArrowLeft,
  Film,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import {
  formatTimestamp,
  classifySegmentRole,
  type HighlightSegmentRecord,
} from '../lib/highlightEngine';
import type { RecentJobSummary } from './LandingSections';

interface AllReelsViewProps {
  darkMode: boolean;
  recentJobs: RecentJobSummary[];
  onSelectJob: (jobId: string) => void;
  onDeleteJob?: (jobId: string) => void;
  onBackToWorkspace: () => void;
  onCompileNew: () => void;
}

function getRoleLabel(seg: HighlightSegmentRecord, duration: number): string {
  const role = seg.role || classifySegmentRole(seg, duration);
  if (role === 'intro') return 'Intro';
  if (role === 'outro') return 'Outro';
  return 'Best Moment';
}

export const AllReelsView: React.FC<AllReelsViewProps> = ({
  darkMode,
  recentJobs,
  onSelectJob,
  onDeleteJob,
  onBackToWorkspace,
  onCompileNew,
}) => {
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [imgErrors, setImgErrors] = useState<Record<string, boolean>>({});

  const filteredJobs = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return recentJobs;
    return recentJobs.filter(({ video, segments }) => {
      const titleMatch = (video?.title || '').toLowerCase().includes(q);
      const channelMatch = (video?.channel || '').toLowerCase().includes(q);
      const segMatch = (segments || []).some((s) =>
        (s.title || '').toLowerCase().includes(q)
      );
      return titleMatch || channelMatch || segMatch;
    });
  }, [recentJobs, searchQuery]);

  return (
    <section
      aria-label="All Compiled Highlight Reels"
      className={`min-h-[calc(100vh-73px)] py-12 px-6 lg:px-12 ${
        darkMode ? 'theme-dark' : 'theme-light'
      }`}
    >
      <div className="max-w-[1120px] mx-auto">
        {/* Page Header */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-8 border-b border-inherit">
          <div>
            <button
              type="button"
              onClick={onBackToWorkspace}
              className={`inline-flex items-center gap-1.5 text-xs font-medium hover:underline underline-offset-4 mb-2 cursor-pointer ${
                darkMode
                  ? 'text-[#94a3b8] hover:text-[#22d3ee]'
                  : 'text-[#57534c] hover:text-[#141311]'
              }`}
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Back to Workspace</span>
            </button>
            <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight">
              All Compiled Reels
            </h1>
            <p
              className={`text-sm mt-1 ${
                darkMode ? 'text-[#94a3b8]' : 'text-[#57534c]'
              }`}
            >
              Select any compiled highlight reel below to watch the video and inspect its stitched timestamps.
            </p>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={onCompileNew}
              className="btn-accent inline-flex items-center gap-1.5 px-4 py-2.5 text-xs font-semibold rounded-md whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>New Reel</span>
            </button>
          </div>
        </div>

        {/* Search Filter Bar */}
        {recentJobs.length > 0 && (
          <div className="mt-6 mb-8 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="relative max-w-md w-full">
              <label htmlFor="reels-search-input" className="sr-only">
                Search compiled reels
              </label>
              <Search
                className={`w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none ${
                  darkMode ? 'text-[#64748b]' : 'text-[#857f75]'
                }`}
              />
              <input
                id="reels-search-input"
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search reels by video title, channel, or clip..."
                className={`w-full pl-10 pr-4 py-2.5 text-xs sm:text-sm rounded-md border transition-colors focus:outline-none focus:ring-2 ${
                  darkMode
                    ? 'bg-[#0b0f14] border-[#1a2634] text-[#ecfeff] placeholder-[#64748b] focus:ring-[#22d3ee]'
                    : 'bg-white border-[#dcd6ca] text-[#141311] placeholder-[#857f75] focus:ring-[#d9381e]'
                }`}
              />
            </div>

            {searchQuery.trim() && (
              <span
                className={`font-mono text-xs tabular-nums ${
                  darkMode ? 'text-[#94a3b8]' : 'text-[#57534c]'
                }`}
              >
                Showing {filteredJobs.length} of {recentJobs.length}
              </span>
            )}
          </div>
        )}

        {/* Reels Grid */}
        {recentJobs.length === 0 ? (
          <div
            className={`mt-8 p-12 rounded-lg border text-center ${
              darkMode ? 'surface-card-dark' : 'surface-card-light'
            }`}
          >
            <h2 className="font-display text-lg font-bold mb-2">
              No Highlight Reels Compiled Yet
            </h2>
            <p
              className={`text-sm max-w-md mx-auto mb-6 ${
                darkMode ? 'text-[#94a3b8]' : 'text-[#57534c]'
              }`}
            >
              Paste a YouTube link or upload a video file in the workspace to compile your first highlight reel.
            </p>
            <button
              type="button"
              onClick={onCompileNew}
              className="btn-accent px-5 py-2.5 text-xs font-semibold rounded-md cursor-pointer"
            >
              Compile Your First Video
            </button>
          </div>
        ) : filteredJobs.length === 0 ? (
          <div
            className={`p-10 rounded-lg border text-center ${
              darkMode ? 'surface-card-dark' : 'surface-card-light'
            }`}
          >
            <p
              className={`text-sm mb-4 ${
                darkMode ? 'text-[#94a3b8]' : 'text-[#57534c]'
              }`}
            >
              No compiled reels match &ldquo;{searchQuery}&rdquo;.
            </p>
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className={`px-4 py-2 text-xs font-medium rounded-md border cursor-pointer ${
                darkMode
                  ? 'border-[#1a2634] text-[#ecfeff] hover:bg-[#111922]'
                  : 'border-[#dcd6ca] text-[#141311] hover:bg-[#ebe6dc]'
              }`}
            >
              Clear Search
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredJobs.map(({ job, video, segmentCount, segments }) => {
              const reelDuration = job.actual_output_duration || job.target_duration;
              const previewSegments = (segments || []).slice(0, 4);
              const hasMoreSegments = (segments || []).length > 4;

              return (
                <article
                  key={job.id}
                  className={`rounded-lg border overflow-hidden flex flex-col justify-between transition-colors ${
                    darkMode
                      ? 'surface-card-dark hover:border-[#22d3ee]/60'
                      : 'surface-card-light hover:border-[#857f75]'
                  }`}
                >
                  <div>
                    {/* Thumbnail & Play Trigger */}
                    <button
                      type="button"
                      onClick={() => onSelectJob(job.id)}
                      className="w-full text-left group cursor-pointer block focus:outline-none"
                    >
                      <div className="aspect-video w-full bg-[#05070a] relative overflow-hidden border-b border-inherit">
                        {!imgErrors[job.id] && video?.thumbnail ? (
                          <img
                            src={video.thumbnail}
                            alt={video.title}
                            referrerPolicy="no-referrer"
                            onError={() =>
                              setImgErrors((prev) => ({ ...prev, [job.id]: true }))
                            }
                            className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-200"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <Film
                              className={`w-7 h-7 ${
                                darkMode ? 'text-[#22d3ee]' : 'text-[#a8a299]'
                              }`}
                            />
                          </div>
                        )}
                        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/25 to-transparent flex items-end justify-between p-4">
                          <span className="font-mono text-xs tabular-nums text-white font-medium">
                            {formatTimestamp(video?.duration || 0)} → {formatTimestamp(reelDuration)}
                          </span>
                          <span
                            className={`inline-flex items-center gap-1.5 px-3 py-1 rounded text-xs font-semibold ${
                              darkMode
                                ? 'bg-[#06b6d4] text-[#030712]'
                                : 'bg-[#d9381e] text-white'
                            }`}
                          >
                            <Play className="w-3 h-3 fill-current" />
                            <span>Choose Reel</span>
                          </span>
                        </div>
                      </div>
                    </button>

                    {/* Reel Details & Compiled Timestamps Preview */}
                    <div className="p-5">
                      <div
                        className={`text-xs font-mono tabular-nums mb-1 ${
                          darkMode ? 'text-[#94a3b8]' : 'text-[#57534c]'
                        }`}
                      >
                        <span>{video?.channel || 'Public Video'}</span>
                        <span aria-hidden="true"> · </span>
                        <span>{segmentCount} clips stitched</span>
                      </div>

                      <h2 className="font-display text-base sm:text-lg font-bold leading-snug mb-3 line-clamp-2">
                        <button
                          type="button"
                          onClick={() => onSelectJob(job.id)}
                          className={`text-left hover:underline underline-offset-4 cursor-pointer ${
                            darkMode ? 'hover:text-[#22d3ee]' : ''
                          }`}
                        >
                          {video?.title || 'Compiled Highlight Video'}
                        </button>
                      </h2>

                      {previewSegments.length > 0 && (
                        <div
                          className={`pt-3 border-t space-y-1.5 ${
                            darkMode ? 'border-[#1a2634]' : 'border-[#dcd6ca]'
                          }`}
                        >
                          <div
                            className={`text-[11px] font-mono ${
                              darkMode ? 'text-[#64748b]' : 'text-[#857f75]'
                            }`}
                          >
                            Compiled Timestamps
                          </div>
                          {previewSegments.map((seg, idx) => (
                            <div
                              key={seg.id || idx}
                              className="flex items-baseline justify-between gap-2 text-xs"
                            >
                              <span className="truncate">
                                <span
                                  className={`font-mono tabular-nums font-medium mr-1.5 ${
                                    darkMode ? 'text-[#22d3ee]' : 'text-[#d9381e]'
                                  }`}
                                >
                                  {getRoleLabel(seg, video?.duration || 0)}
                                </span>
                                <span
                                  className={
                                    darkMode ? 'text-[#94a3b8]' : 'text-[#57534c]'
                                  }
                                >
                                  {seg.title}
                                </span>
                              </span>
                              <span className="font-mono tabular-nums shrink-0 text-[11px]">
                                {formatTimestamp(seg.start_time)}–{formatTimestamp(seg.end_time)}
                              </span>
                            </div>
                          ))}
                          {hasMoreSegments && (
                            <div
                              className={`text-[11px] font-mono pt-0.5 ${
                                darkMode ? 'text-[#94a3b8]' : 'text-[#57534c]'
                              }`}
                            >
                              + {(segments || []).length - 4} more compiled clips
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  <div
                    className={`px-5 py-3.5 border-t flex items-center justify-between gap-2 ${
                      darkMode
                        ? 'border-[#1a2634] bg-[#05070a]'
                        : 'border-[#dcd6ca] bg-[#f5f2eb]/60'
                    }`}
                  >
                    <span
                      className={`font-mono text-xs tabular-nums ${
                        darkMode ? 'text-[#94a3b8]' : 'text-[#57534c]'
                      }`}
                    >
                      Reel length: {formatTimestamp(reelDuration)}
                    </span>
                    <div className="flex items-center gap-2 shrink-0">
                      {onDeleteJob && (
                        <button
                          type="button"
                          onClick={() => onDeleteJob(job.id)}
                          title="Delete compiled reel"
                          className={`p-1.5 rounded-md border transition-colors cursor-pointer ${
                            darkMode
                              ? 'border-[#1a2634] text-[#94a3b8] hover:text-[#ecfeff] hover:bg-[#111922]'
                              : 'border-[#dcd6ca] text-[#57534c] hover:text-[#141311] hover:bg-[#ebe6dc]'
                          }`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => onSelectJob(job.id)}
                        className="btn-accent inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-md cursor-pointer whitespace-nowrap shrink-0"
                      >
                        <Play className="w-3 h-3 fill-current" />
                        <span>Watch Video</span>
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
};
