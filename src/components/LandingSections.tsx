import React from 'react';
import { Play, ArrowUpRight, ArrowRight, Film } from 'lucide-react';
import {
  formatTimestamp,
  type HighlightJobRecord,
  type HighlightSegmentRecord,
  type VideoRecord,
} from '../lib/highlightEngine';

export interface RecentJobSummary {
  job: HighlightJobRecord;
  video: VideoRecord;
  segmentCount: number;
  segments?: HighlightSegmentRecord[];
}

interface LandingSectionsProps {
  darkMode: boolean;
  recentJobs: RecentJobSummary[];
  onSelectJob: (jobId: string) => void;
  onOpenAllReels: () => void;
  onFocusTopInput: () => void;
}

const PROCESS_STEPS = [
  {
    number: '01.',
    title: 'Provide source footage',
    body: 'Paste any public YouTube link or upload an MP4/MOV video file from your device.',
  },
  {
    number: '02.',
    title: 'Intro, best moments & outro',
    body: 'Incorporates the opening intro and closing outro alongside the highest-impact moments in chronological order.',
  },
  {
    number: '03.',
    title: 'Watch & download MP4',
    body: 'Stream your compiled highlight video with interactive timestamps beneath the player or save the MP4 file.',
  },
];

export const LandingSections: React.FC<LandingSectionsProps> = ({
  darkMode,
  recentJobs,
  onSelectJob,
  onOpenAllReels,
  onFocusTopInput,
}) => {
  return (
    <>
      {/* Compiled Reels Preview Section */}
      {recentJobs.length > 0 && (
        <section
          id="library"
          className={`py-14 px-6 lg:px-12 border-b transition-colors ${
            darkMode
              ? 'bg-[#05070a] border-[#1a2634]'
              : 'bg-[#f5f2eb] border-[#dcd6ca]'
          }`}
        >
          <div className="max-w-[1120px] mx-auto">
            <div className="flex items-baseline justify-between gap-4 mb-6">
              <div>
                <h2 className="font-display text-xl sm:text-2xl font-bold tracking-tight">
                  Recent Reels
                </h2>
              </div>
              <button
                type="button"
                onClick={onOpenAllReels}
                className={`inline-flex items-center gap-1.5 text-xs font-semibold hover:underline underline-offset-4 cursor-pointer ${
                  darkMode ? 'text-[#ecfeff] hover:text-[#22d3ee]' : 'text-[#141311]'
                }`}
              >
                <span>View All Reels</span>
                <ArrowRight
                  className={`w-3.5 h-3.5 ${
                    darkMode ? 'text-[#22d3ee]' : 'text-[#d9381e]'
                  }`}
                />
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              {recentJobs.slice(0, 3).map(({ job, video, segmentCount }) => (
                <button
                  key={job.id}
                  type="button"
                  onClick={() => onSelectJob(job.id)}
                  className={`group text-left rounded-lg border overflow-hidden transition-colors cursor-pointer flex flex-col justify-between ${
                    darkMode
                      ? 'surface-card-dark hover:border-[#22d3ee]/60'
                      : 'surface-card-light hover:border-[#857f75]'
                  }`}
                >
                  <div className="w-full">
                    <div className="aspect-video w-full bg-[#05070a] relative overflow-hidden border-b border-inherit">
                      {video?.thumbnail ? (
                        <img
                          src={video.thumbnail}
                          alt={video.title}
                          referrerPolicy="no-referrer"
                          className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-200"
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
                      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent flex items-end justify-between p-3.5">
                        <span className="font-mono text-xs tabular-nums text-white font-medium">
                          {formatTimestamp(job.actual_output_duration || job.target_duration)}
                        </span>
                        <span
                          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-semibold ${
                            darkMode
                              ? 'bg-[#06b6d4] text-[#030712]'
                              : 'bg-[#d9381e] text-white'
                          }`}
                        >
                          <Play className="w-3 h-3 fill-current" />
                          <span>Watch</span>
                        </span>
                      </div>
                    </div>

                    <div className="p-4">
                      <h3 className="font-display text-sm sm:text-base font-bold truncate mb-1">
                        {video?.title || 'Compiled Highlight Video'}
                      </h3>
                      <p
                        className={`font-mono text-xs tabular-nums ${
                          darkMode ? 'text-[#94a3b8]' : 'text-[#57534c]'
                        }`}
                      >
                        {formatTimestamp(video?.duration || 0)} source · {segmentCount} clips stitched
                      </p>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Concise 3-Step Process Strip */}
      <section
        id="process"
        className={`py-16 px-6 lg:px-12 border-b transition-colors ${
          darkMode
            ? 'bg-[#05070a] border-[#1a2634]'
            : 'bg-[#f5f2eb] border-[#dcd6ca]'
        }`}
      >
        <div className="max-w-[1120px] mx-auto">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {PROCESS_STEPS.map((step) => (
              <div
                key={step.number}
                className={`pt-5 border-t ${
                  darkMode ? 'border-[#1a2634]' : 'border-[#dcd6ca]'
                }`}
              >
                <div
                  className={`font-mono text-xs font-semibold mb-2 tabular-nums ${
                    darkMode ? 'text-[#22d3ee]' : 'text-[#d9381e]'
                  }`}
                >
                  {step.number}
                </div>
                <h2 className="font-display text-lg font-bold mb-1.5">{step.title}</h2>
                <p
                  className={`text-sm leading-relaxed ${
                    darkMode ? 'text-[#94a3b8]' : 'text-[#57534c]'
                  }`}
                >
                  {step.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Quiet Minimal Footer */}
      <footer
        className={`py-8 px-6 lg:px-12 transition-colors ${
          darkMode
            ? 'bg-[#05070a] text-[#94a3b8]'
            : 'bg-[#f5f2eb] text-[#57534c]'
        }`}
      >
        <div className="max-w-[1120px] mx-auto flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 text-xs">
          <div className="flex items-center gap-2.5">
            <span
              className={`font-display text-sm font-bold ${
                darkMode ? 'text-[#ecfeff]' : 'text-[#141311]'
              }`}
            >
              Highlight
              <span className={darkMode ? 'text-[#22d3ee]' : 'text-[#d9381e]'}>.</span>
            </span>
            <span aria-hidden="true">·</span>
            <span>Automated Video Highlight Compiler</span>
          </div>

          <div className="flex items-center gap-6">
            <button
              type="button"
              onClick={onOpenAllReels}
              className={`font-medium hover:underline underline-offset-4 cursor-pointer ${
                darkMode ? 'text-[#ecfeff] hover:text-[#22d3ee]' : 'text-[#141311]'
              }`}
            >
              All Reels
            </button>
            <button
              type="button"
              onClick={onFocusTopInput}
              className={`inline-flex items-center gap-1 font-medium hover:underline underline-offset-4 cursor-pointer ${
                darkMode ? 'text-[#ecfeff] hover:text-[#22d3ee]' : 'text-[#141311]'
              }`}
            >
              <span>Compile another video</span>
              <ArrowUpRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </footer>
    </>
  );
};
