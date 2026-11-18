import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const dynamic = 'force-dynamic';

// The display name is deployment configuration, read on the server.
export function generateMetadata(): Metadata {
  return { title: process.env.AFTERCARE_DISPLAY_NAME ?? 'Aftercare Trace' };
}

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
