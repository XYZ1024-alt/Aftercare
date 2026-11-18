import localFont from 'next/font/local';

// Complete official fonts, self-hosted (the console loads nothing from another
// origin). Latin text and figures use Inter; Chinese falls through to 思源黑体 CN.
// Provenance and licences: ./fonts/README.md.

export const inter = localFont({
  src: './fonts/InterVariable.woff2',
  variable: '--font-inter',
  weight: '100 900',
  display: 'swap',
});

export const sourceHanSans = localFont({
  src: [
    { path: './fonts/SourceHanSansCN-Regular.woff2', weight: '400' },
    { path: './fonts/SourceHanSansCN-Medium.woff2', weight: '500' },
    { path: './fonts/SourceHanSansCN-Bold.woff2', weight: '700' },
  ],
  variable: '--font-source-han-sans',
  display: 'swap',
  // Several megabytes each: fetched when Chinese text is first drawn, not preloaded.
  preload: false,
  adjustFontFallback: false,
});
