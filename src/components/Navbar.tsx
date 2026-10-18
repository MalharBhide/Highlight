import React from 'react';

interface NavbarProps {
  darkMode: boolean;
  activeScreen: 'home' | 'processing' | 'results' | 'reels';
  onToggleDarkMode: () => void;
  onNavigateHome: () => void;
  onFocusInput: () => void;
  recentJobCount: number;
  onOpenAllReels: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  darkMode,
  activeScreen,
  onToggleDarkMode,
  onNavigateHome,
  onFocusInput,
  recentJobCount,
  onOpenAllReels,
}) => {
  return (
    <header
      className={`sticky top-0 z-30 flex items-center justify-between gap-8 px-6 lg:px-12 py-4 border-b transition-colors ${
        darkMode
          ? 'bg-[#05070a]/95 border-[#1a2634] text-[#ecfeff]'
          : 'bg-[#f5f2eb]/95 border-[#dcd6ca] text-[#141311]'
      } backdrop-blur-sm`}
    >
      {/* Zone 1: Brand Wordmark */}
      <a
        href="#top"
        onClick={(e) => {
          e.preventDefault();
          onNavigateHome();
        }}
        className={`font-display text-xl font-bold tracking-tight whitespace-nowrap shrink-0 focus-visible:outline-2 ${
          darkMode ? 'focus-visible:outline-[#22d3ee]' : 'focus-visible:outline-[#d9381e]'
        }`}
      >
        Highlight<span className={darkMode ? 'text-[#22d3ee]' : 'text-[#d9381e]'}>.</span>
      </a>

      {/* Zone 2: Concise Single-Line Navigation Links */}
      <nav
        aria-label="Primary Navigation"
        className={`hidden md:flex items-center gap-8 text-sm font-medium ${
          darkMode ? 'text-[#94a3b8]' : 'text-[#57534c]'
        }`}
      >
        <a
          href="#workspace"
          onClick={() => onNavigateHome()}
          className={`hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0 ${
            activeScreen === 'home'
              ? darkMode
                ? 'text-[#22d3ee] underline'
                : 'text-[#141311] underline'
              : darkMode
              ? 'hover:text-[#ecfeff]'
              : 'hover:text-[#141311]'
          }`}
        >
          Workspace
        </a>
        <button
          type="button"
          onClick={onOpenAllReels}
          className={`hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
            activeScreen === 'reels'
              ? darkMode
                ? 'text-[#22d3ee] underline'
                : 'text-[#141311] underline'
              : darkMode
              ? 'hover:text-[#ecfeff]'
              : 'hover:text-[#141311]'
          }`}
        >
          All Reels
        </button>
        <button
          type="button"
          onClick={onToggleDarkMode}
          className={`hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
            darkMode ? 'text-[#22d3ee] hover:text-[#ecfeff]' : 'hover:text-[#141311]'
          }`}
        >
          {darkMode ? 'Light Paper' : 'Dark Room'}
        </button>
      </nav>

      {/* Zone 3: 1 Primary CTA */}
      <div className="flex items-center shrink-0">
        <button
          type="button"
          onClick={onFocusInput}
          className="btn-accent px-4 py-2 text-xs font-semibold rounded-md whitespace-nowrap shrink-0 cursor-pointer"
        >
          New Reel
        </button>
      </div>
    </header>
  );
};
