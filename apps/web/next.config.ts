import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

// One .env for the whole workspace, at the repository root.
const workspaceEnvFile = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(workspaceEnvFile)) {
  process.loadEnvFile(workspaceEnvFile);
}

const development = process.env.NODE_ENV !== 'production';

// The console loads nothing from another origin and may not be framed.
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
  "frame-ancestors 'none'",
].join('; ');

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
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
      ],
    },
  ],
};

export default nextConfig;
