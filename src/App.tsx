/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Loader2 } from 'lucide-react';
import { Navbar } from './components/Navbar';
import { HeroWorkspace } from './components/HeroWorkspace';
import { ProcessingView } from './components/ProcessingView';
import { ResultsView } from './components/ResultsView';
import { AllReelsView } from './components/AllReelsView';
import { LandingSections, type RecentJobSummary } from './components/LandingSections';
import {
  extractYouTubeVideoId,
  extractSharedReelJobId,
  clampKeepPercentage,
  DEFAULT_KEEP_PERCENTAGE,
  type HighlightJobRecord,
  type HighlightSegmentRecord,
  type VideoRecord,
} from './lib/highlightEngine';
import {
  getClientHeaders,
  recordOwnedJobId,
  removeOwnedJobId,
} from './lib/clientSession';

type ActiveScreen = 'home' | 'processing' | 'results' | 'reels';

function getInitialSharedReelId(): string | null {
  if (typeof window === 'undefined') return null;
  return extractSharedReelJobId(window.location.href);
}

export default function App() {
  const initialSharedId = getInitialSharedReelId();
  const [darkMode, setDarkMode] = useState<boolean>(false);
  const [screen, setScreen] = useState<ActiveScreen>(initialSharedId ? 'results' : 'home');
  const [loadingSharedReel, setLoadingSharedReel] = useState<boolean>(Boolean(initialSharedId));
  const [urlInput, setUrlInput] = useState<string>('');
  const [keepPercentage, setKeepPercentage] = useState<number>(DEFAULT_KEEP_PERCENTAGE);
  const [creatingJob, setCreatingJob] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [activeJob, setActiveJob] = useState<
    (HighlightJobRecord & { download_ready?: boolean }) | null
  >(null);
  const [activeVideo, setActiveVideo] = useState<VideoRecord | null>(null);
  const [activeSegments, setActiveSegments] = useState<HighlightSegmentRecord[]>([]);

  const [recentJobs, setRecentJobs] = useState<RecentJobSummary[]>([]);

  const inputRef = useRef<HTMLInputElement | null>(null);

  const fetchRecentJobs = useCallback(async () => {
    try {
      const jobsRes = await fetch('/api/highlights', {
        headers: getClientHeaders(),
      });
      if (jobsRes.ok) {
        const jobsData = (await jobsRes.json()) as { items?: RecentJobSummary[] };
        setRecentJobs(jobsData.items || []);
      }
    } catch {
      // ignore initial fetch errors
    }
  }, []);

  const loadJobDetails = useCallback(
    async (jobId: string) => {
      try {
        const res = await fetch(`/api/highlights/${encodeURIComponent(jobId)}`, {
          headers: getClientHeaders(),
        });
        if (!res.ok) {
          setLoadingSharedReel(false);
          setScreen('home');
          setErrorMsg('The requested shared highlight reel could not be found.');
          return;
        }
        const data = (await res.json()) as {
          job: HighlightJobRecord & { download_ready?: boolean };
          video: VideoRecord;
          segments?: HighlightSegmentRecord[];
        };

        if (data.job.status === 'complete') {
          let resolvedSegments = data.segments;
          if (!resolvedSegments) {
            const segRes = await fetch(`/api/highlights/${encodeURIComponent(jobId)}/segments`, {
              headers: getClientHeaders(),
            });
            if (segRes.ok) {
              const segData = (await segRes.json()) as { segments?: HighlightSegmentRecord[] };
              resolvedSegments = segData.segments || [];
            }
          }
          setActiveJob(data.job);
          setActiveVideo(data.video);
          setActiveSegments(resolvedSegments || []);
          setScreen('results');
          const encoded = encodeURIComponent(jobId);
          const nextUrl = `/?reel=${encoded}#reel=${encoded}`;
          window.history.replaceState(null, '', nextUrl);
          window.scrollTo({ top: 0, behavior: 'smooth' });
          void fetchRecentJobs();
        } else {
          setActiveJob(data.job);
          setActiveVideo(data.video);
          if (data.job.keep_percentage !== undefined) {
            setKeepPercentage(clampKeepPercentage(data.job.keep_percentage));
          }
          setScreen('processing');
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
      } finally {
        setLoadingSharedReel(false);
      }
    },
    [fetchRecentJobs]
  );

  useEffect(() => {
    void fetchRecentJobs();
    const sharedReelId = extractSharedReelJobId(window.location.href);
    if (sharedReelId) {
      setLoadingSharedReel(true);
      void loadJobDetails(sharedReelId);
    }

    const handleUrlChange = () => {
      const nextSharedId = extractSharedReelJobId(window.location.href);
      if (nextSharedId) {
        setLoadingSharedReel(true);
        void loadJobDetails(nextSharedId);
      }
    };

    window.addEventListener('popstate', handleUrlChange);
    window.addEventListener('hashchange', handleUrlChange);
    return () => {
      window.removeEventListener('popstate', handleUrlChange);
      window.removeEventListener('hashchange', handleUrlChange);
    };
  }, [fetchRecentJobs, loadJobDetails]);

  useEffect(() => {
    if (screen !== 'home') return;
    const trimmed = urlInput.trim();
    if (!trimmed || extractSharedReelJobId(trimmed)) return;
    const vidId = extractYouTubeVideoId(trimmed);
    if (!vidId) return;

    const timer = setTimeout(() => {
      void fetch('/api/videos/inspect', {
        method: 'POST',
        headers: getClientHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ url: trimmed, keepPercentage }),
      }).catch(() => {
        // ignore pre-warm network errors
      });
    }, 200);

    return () => clearTimeout(timer);
  }, [screen, urlInput, keepPercentage]);

  useEffect(() => {
    if (screen !== 'processing' || !activeJob) return;
    if (activeJob.status === 'complete' || activeJob.status === 'failed') return;

    const initialPoll = setTimeout(() => {
      void loadJobDetails(activeJob.id);
    }, 120);
    const timer = setInterval(() => {
      void loadJobDetails(activeJob.id);
    }, 250);

    return () => {
      clearTimeout(initialPoll);
      clearInterval(timer);
    };
  }, [screen, activeJob, loadJobDetails]);

  const handleGenerateHighlights = async (
    targetUrl?: string,
    customDurationSeconds?: number,
    channelAccessToken?: string
  ) => {
    const raw = (targetUrl ?? urlInput).trim();
    setErrorMsg(null);

    if (!raw) {
      setErrorMsg('Please paste a YouTube URL or upload a video file.');
      return;
    }

    // If the user pastes a direct Share link to an existing compiled reel, open that compiled reel directly
    const sharedJobId = extractSharedReelJobId(raw);
    if (sharedJobId) {
      setLoadingSharedReel(true);
      await loadJobDetails(sharedJobId);
      return;
    }

    const videoId = extractYouTubeVideoId(raw);
    if (!videoId) {
      setErrorMsg(
        'Invalid YouTube URL. Supported formats: youtube.com/watch?v=ID, youtu.be/ID, youtube.com/shorts/ID, or a shared Highlight reel link.'
      );
      return;
    }

    const validPct = clampKeepPercentage(keepPercentage);

    try {
      setCreatingJob(true);
      const res = await fetch('/api/highlights', {
        method: 'POST',
        headers: getClientHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          url: raw,
          durationSeconds: customDurationSeconds,
          channelAccessToken,
          keepPercentage: validPct,
        }),
      });
      const data = (await res.json()) as {
        job?: HighlightJobRecord;
        video?: VideoRecord;
        error?: string;
      };
      if (!res.ok || !data.job || !data.video) {
        throw new Error(data.error || 'Failed to start highlight generation job.');
      }
      recordOwnedJobId(data.job.id);
      setActiveJob(data.job);
      setActiveVideo(data.video);
      setActiveSegments([]);
      setScreen('processing');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to create highlight job.');
    } finally {
      setCreatingJob(false);
    }
  };

  const handleUploadVideoFile = async (file: File, optionalYoutubeUrl?: string) => {
    setErrorMsg(null);
    const validPct = clampKeepPercentage(keepPercentage);
    try {
      setCreatingJob(true);
      const formData = new FormData();
      formData.append('file', file);
      formData.append('keepPercentage', String(validPct));
      if (optionalYoutubeUrl && optionalYoutubeUrl.trim()) {
        formData.append('url', optionalYoutubeUrl.trim());
      }

      const res = await fetch('/api/highlights/upload', {
        method: 'POST',
        headers: getClientHeaders(),
        body: formData,
      });
      const data = (await res.json()) as {
        job?: HighlightJobRecord;
        video?: VideoRecord;
        error?: string;
      };
      if (!res.ok || !data.job || !data.video) {
        throw new Error(data.error || 'Failed to upload and compile video file.');
      }
      recordOwnedJobId(data.job.id);
      setActiveJob(data.job);
      setActiveVideo(data.video);
      setActiveSegments([]);
      setScreen('processing');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to upload video file.');
    } finally {
      setCreatingJob(false);
    }
  };

  const handleRetryJob = async () => {
    if (!activeJob) return;
    const res = await fetch(`/api/highlights/${activeJob.id}/retry`, {
      method: 'POST',
      headers: getClientHeaders(),
    });
    if (res.ok) {
      await loadJobDetails(activeJob.id);
    }
  };

  const handleDeleteJob = useCallback(
    async (jobId: string) => {
      try {
        await fetch(`/api/highlights/${encodeURIComponent(jobId)}`, {
          method: 'DELETE',
          headers: getClientHeaders(),
        });
      } catch {
        // ignore network error
      }
      removeOwnedJobId(jobId);
      setRecentJobs((prev) => prev.filter((item) => item.job.id !== jobId));
      if (activeJob?.id === jobId) {
        window.history.replaceState(null, '', '/');
        setActiveJob(null);
        setActiveVideo(null);
        setActiveSegments([]);
        setScreen('home');
      }
    },
    [activeJob?.id]
  );

  const handleNavigateHome = () => {
    window.history.replaceState(null, '', '/');
    setLoadingSharedReel(false);
    setScreen('home');
  };

  const handleFocusInput = () => {
    window.history.replaceState(null, '', '/');
    setLoadingSharedReel(false);
    if (screen !== 'home') {
      setScreen('home');
      setTimeout(() => {
        inputRef.current?.focus();
      }, 60);
    } else {
      inputRef.current?.focus();
    }
  };

  const handleOpenAllReels = () => {
    window.history.replaceState(null, '', '/');
    setLoadingSharedReel(false);
    void fetchRecentJobs();
    setScreen('reels');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className={darkMode ? 'dark theme-dark min-h-screen' : 'theme-light min-h-screen'}>
      <Navbar
        darkMode={darkMode}
        activeScreen={screen}
        onToggleDarkMode={() => setDarkMode((prev) => !prev)}
        onNavigateHome={handleNavigateHome}
        onFocusInput={handleFocusInput}
        recentJobCount={recentJobs.length}
        onOpenAllReels={handleOpenAllReels}
      />

      <main>
        {loadingSharedReel && (!activeJob || !activeVideo) && (
          <section className="py-24 px-6 flex items-center justify-center">
            <div className="inline-flex items-center gap-2.5 font-mono text-sm">
              <Loader2
                className={`w-4 h-4 animate-spin ${
                  darkMode ? 'text-[#22d3ee]' : 'text-[#d9381e]'
                }`}
              />
              <span>Opening compiled highlight video...</span>
            </div>
          </section>
        )}

        {!loadingSharedReel && screen === 'home' && (
          <>
            <HeroWorkspace
              darkMode={darkMode}
              urlInput={urlInput}
              onUrlInputChange={setUrlInput}
              keepPercentage={keepPercentage}
              onKeepPercentageChange={(val) => setKeepPercentage(clampKeepPercentage(val))}
              inputRef={inputRef}
              creatingJob={creatingJob}
              errorMsg={errorMsg}
              onGenerateHighlights={handleGenerateHighlights}
              onUploadVideoFile={handleUploadVideoFile}
            />
            <LandingSections
              darkMode={darkMode}
              recentJobs={recentJobs}
              onSelectJob={(jobId) => void loadJobDetails(jobId)}
              onDeleteJob={(jobId) => void handleDeleteJob(jobId)}
              onOpenAllReels={handleOpenAllReels}
              onFocusTopInput={handleFocusInput}
            />
          </>
        )}

        {screen === 'reels' && (
          <AllReelsView
            darkMode={darkMode}
            recentJobs={recentJobs}
            onSelectJob={(jobId) => void loadJobDetails(jobId)}
            onDeleteJob={(jobId) => void handleDeleteJob(jobId)}
            onBackToWorkspace={handleNavigateHome}
            onCompileNew={handleFocusInput}
          />
        )}

        {screen === 'processing' && activeJob && activeVideo && (
          <ProcessingView
            darkMode={darkMode}
            job={activeJob}
            video={activeVideo}
            keepPercentage={clampKeepPercentage(activeJob.keep_percentage ?? keepPercentage)}
            onRetry={handleRetryJob}
            onCancel={handleNavigateHome}
          />
        )}

        {screen === 'results' && activeJob && activeVideo && (
          <ResultsView
            darkMode={darkMode}
            job={activeJob}
            video={activeVideo}
            segments={activeSegments}
            onBackToWorkspace={handleNavigateHome}
            onOpenAllReels={handleOpenAllReels}
            onRefreshJob={() => loadJobDetails(activeJob.id)}
            onDeleteJob={() => void handleDeleteJob(activeJob.id)}
          />
        )}
      </main>
    </div>
  );
}
