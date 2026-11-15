import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

// One .env for the whole workspace, at the repository root.
const workspaceEnvFile = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(workspaceEnvFile)) {
  process.loadEnvFile(workspaceEnvFile);
}

const nextConfig: NextConfig = {
  // Workspace packages are consumed as TypeScript sources.
  transpilePackages: ['@aftercare/contracts', '@aftercare/domain', '@aftercare/storage'],
};

export default nextConfig;
