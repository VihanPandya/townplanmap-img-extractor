import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'TownPlanMap Image Explorer',
  description:
    'Discover, inspect and organise publicly available images from townplanmap.com or any other permitted website.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f7f9' },
    { media: '(prefers-color-scheme: dark)', color: '#08090c' },
  ],
};

/**
 * Applied before first paint so the page never flashes the wrong theme.
 * Kept inline and tiny on purpose.
 */
const themeBootstrap = `(function(){try{var s=localStorage.getItem('tpm-theme');var m=window.matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.setAttribute('data-theme',s==='light'||s==='dark'?s:(m?'dark':'light'));}catch(e){document.documentElement.setAttribute('data-theme','light');}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
