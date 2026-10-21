/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Navbar } from './components/Navbar';
import { HeroWorkspace } from './components/HeroWorkspace';
import { ProcessingView } from './components/ProcessingView';
import { ResultsView } from './components/ResultsView';
import { AllReelsView } from './components/AllReelsView';
import { LandingSections, type RecentJobSummary } from './components/LandingSections';
import {
  extractYouTubeVideoId,
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

export default function App() {
  const [darkMode, setDarkMode] = useState<boolean>(false);
  const [screen, setScreen] = useState<ActiveScreen>('home');
  const [urlInput, setUrlInput] = useState<string>('');
  const [keepPercentage, setKeepPercentage] = useState<number>(DEFAULT_KEEP_PERCENTAGE);
  const [creatingJob, setCreatingJob] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [activeJob, setActiveJob] = useState<
    (HighlightJobRecord & { download_ready?: boolean }) | null
  >(null);
  const [activeVideo, setActiveVideo] = useState<VideoRecord | null>(null);
  const [activeSegments, setActiveSegments] = useState<HighlightSegmentRecord[]>([]);

  const [freeDemoMode, setFreeDemoMode] = useState(false);

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
      const res = await fetch(`/api/highlights/${encodeURIComponent(jobId)}`, {
        headers: getClientHeaders(),
      });
      if (!res.ok) {
        setScreen('home');
        setErrorMsg('The requested highlight reel could not be found.');
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
        setScreen((prev) => {
          if (prev !== 'results') {
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }
          return 'results';
        });
        void fetchRecentJobs();
      } else {
        setActiveJob(data.job);
        setActiveVideo(data.video);
        if (data.job.keep_percentage !== undefined) {
          setKeepPercentage(clampKeepPercentage(data.job.keep_percentage));
        }
        setScreen((prev) => {
          if (prev !== 'processing') {
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }
          return 'processing';
        });
      }
    },
    [fetchRecentJobs]
  );

  useEffect(() => {
    void fetch('/api/system/status').then((response) => response.json()).then((status) => {
      setFreeDemoMode(status.freeDemoMode === true);
    }).catch(() => {});
    void fetchRecentJobs();
  }, [fetchRecentJobs]);

  useEffect(() => {
    if (screen !== 'home') return;
    const trimmed = urlInput.trim();
    if (!trimmed) return;
    const vidId = extractYouTubeVideoId(trimmed);
    if (!vidId) return;

    const timer = setTimeout(() => {
      void fetch('/api/videos/inspect', {
        method: 'POST',
        headers: getClientHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ url: trimmed }),
      }).catch(() => {
        // ignore pre-warm network errors
      });
    }, 350);

    return () => clearTimeout(timer);
  }, [screen, urlInput]);

  const activeJobId = activeJob?.id;
  const activeJobStatus = activeJob?.status;

  useEffect(() => {
    if (screen !== 'processing' || !activeJobId) return;
    if (activeJobStatus === 'complete') return;

    let cancelled = false;
    let inFlight = false;

    const poll = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        await loadJobDetails(activeJobId);
      } catch {
        // A transient polling error should not terminate progress updates.
      } finally {
        inFlight = false;
      }
    };

    const initialPoll = setTimeout(() => {
      void poll();
    }, 150);
    const timer = setInterval(() => {
      void poll();
    }, 1500);

    return () => {
      cancelled = true;
      clearTimeout(initialPoll);
      clearInterval(timer);
    };
  }, [screen, activeJobId, activeJobStatus, loadJobDetails]);

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

    const videoId = extractYouTubeVideoId(raw);
    if (!videoId) {
      setErrorMsg(
        'Invalid YouTube URL. Supported formats: youtube.com/watch?v=ID, youtu.be/ID, or youtube.com/shorts/ID.'
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
    const res = await fetch(`/api/highlights/${encodeURIComponent(activeJob.id)}/retry`, {
      method: 'POST',
      headers: getClientHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        url: activeVideo?.original_url || urlInput,
        keepPercentage: activeJob.keep_percentage ?? keepPercentage,
      }),
    });
    if (res.ok) {
      await loadJobDetails(activeJob.id);
    } else if (activeVideo?.original_url) {
      await handleGenerateHighlights(activeVideo.original_url);
    }
  };

  const handleDeleteJob = useCallback(
    async (jobId: string) => {
      try {
        const response = await fetch(`/api/highlights/${encodeURIComponent(jobId)}`, {
          method: 'DELETE',
          headers: getClientHeaders(),
        });
        if (!response.ok) throw new Error('Could not delete this reel. Please try again.');
      } catch (error) {
        setErrorMsg(error instanceof Error ? error.message : 'Could not delete this reel.');
        return;
      }
      removeOwnedJobId(jobId);
      setRecentJobs((prev) => prev.filter((item) => item.job.id !== jobId));
      if (activeJob?.id === jobId) {
        setActiveJob(null);
        setActiveVideo(null);
        setActiveSegments([]);
        setScreen('home');
      }
    },
    [activeJob?.id]
  );

  const handleNavigateHome = () => {
    setScreen('home');
  };

  const handleFocusInput = () => {
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
        {freeDemoMode && (
          <p role="status" className="px-6 py-3 text-center text-sm border-b">
            Free demo: videos up to 5 minutes and 50 MB, with 480p output. Download your reel now; saved videos disappear when the server sleeps or restarts.
          </p>
        )}
        {screen === 'home' && (
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
