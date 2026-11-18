import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

// One .env for the whole workspace, at the repository root.
const workspaceEnvFile = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(workspaceEnvFile)) {
  process.loadEnvFile(workspaceEnvFile);
}

const development = process.env.NODE_ENV !== 'production';

// The console loads nothing from another origin. It may not be framed unless
// the deployment names the parent origins that are allowed to embed it (a
// ModelScope Studio embeds it from https://modelscope.cn). Unset: no framing,
// which is the right default for a console that changes state.
const frameAncestors = process.env.AFTERCARE_CONSOLE_FRAME_ANCESTORS?.trim() || null;
// Scripts: Next.js bootstraps with inline scripts, so 'unsafe-inline' stays;
// what keeps recorded text from running is that it is rendered as text
// (React escaping, Markdown without raw HTML) — see untrusted-text.tsx.
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${development ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  frameAncestors === null ? "frame-ancestors 'none'" : `frame-ancestors ${frameAncestors}`,
].join('; ');

// X-Frame-Options has no allow-list for modern browsers; when framing is
// allowed, the CSP frame-ancestors directive above is the only control.
const frameHeaders: { key: string; value: string }[] =
  frameAncestors === null ? [{ key: 'X-Frame-Options', value: 'DENY' }] : [];

const nextConfig: NextConfig = {
  // Workspace packages are consumed as TypeScript sources.
  transpilePackages: [
    '@aftercare/agent',
    '@aftercare/casework',
    '@aftercare/console',
    '@aftercare/contracts',
    '@aftercare/domain',
    '@aftercare/evidence',
    '@aftercare/execution',
    '@aftercare/repair',
    '@aftercare/storage',
    '@aftercare/verify',
  ],
  serverExternalPackages: ['pg'],
  // A second instance (the end-to-end tests) builds into its own directory.
  distDir: process.env.AFTERCARE_NEXT_DIST_DIR ?? '.next',
  devIndicators: false,
  headers: async () => [
    {
      source: '/:path*',
      headers: [
        { key: 'Content-Security-Policy', value: contentSecurityPolicy },
        ...frameHeaders,
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
      ],
    },
  ],
};

export default nextConfig;
