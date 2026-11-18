'use client';

import { FlaskConical, LogOut, PlugZap } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { sendJson } from '../../lib/api.ts';
import { SessionGate, useCan, useSession } from '../../lib/session.tsx';

const LINKS = [
  { href: '/', label: '概览', current: (path: string) => path === '/' },
  {
    href: '/cases',
    label: '案例',
    current: (path: string) => path.startsWith('/cases') && path !== '/cases/new',
  },
  { href: '/cases/new', label: '提交事故', current: (path: string) => path === '/cases/new' },
] as const;
const ADMIN_LINK = {
  href: '/admin',
  label: '本地管理',
  current: (path: string) => path.startsWith('/admin'),
} as const;

function TopNav() {
  const { session, displayName, modelMode, csrfToken } = useSession();
  const admin = useCan('administer_local');
  const path = usePathname();
  const signOut = async () => {
    await sendJson('/api/session', {}, csrfToken, 'DELETE');
    window.location.assign('/login');
  };
  return (
    <>
      <header className="sticky top-0 z-20 bg-nav text-on-dark">
        <div className="mx-auto flex min-h-15 max-w-[1240px] flex-wrap items-center gap-x-2 gap-y-1 px-6 max-md:px-4 max-md:py-2">
          <Link href="/" className="mr-3 text-base font-semibold tracking-[-0.02em]">
            {displayName}
          </Link>
          <nav
            aria-label="主要页面"
            className="flex flex-1 gap-1 max-md:order-last max-md:basis-full max-md:overflow-x-auto"
          >
            {[...LINKS, ...(admin ? [ADMIN_LINK] : [])].map((link) => {
              const current = link.current(path);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  aria-current={current ? 'page' : undefined}
                  className={`inline-flex h-9 shrink-0 items-center rounded-full px-3.5 text-sm font-medium transition-colors duration-160 ${current ? 'bg-white text-nav' : 'text-on-dark-muted hover:bg-white/6 hover:text-on-dark'}`}
                >
                  {link.label}
                </Link>
              );
            })}
          </nav>
          <span
            className="ml-auto truncate text-meta text-on-dark-muted max-sm:max-w-40"
            data-testid="principal"
          >
            {session.displayName}（{session.principal}）
          </span>
          <button
            type="button"
            onClick={() => void signOut()}
            className="inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-sm font-medium text-on-dark-muted transition-colors duration-160 hover:bg-white/6 hover:text-on-dark"
          >
            <LogOut aria-hidden className="size-4" />
            退出
          </button>
        </div>
      </header>
      {modelMode === 'scripted_test' && (
        <p
          data-testid="test-mode-banner"
          className="flex items-center justify-center gap-2 bg-apricot-soft px-6 py-2 text-center text-meta font-medium text-apricot-ink"
        >
          <FlaskConical aria-hidden className="size-4 shrink-0" />
          测试模式：运行由脚本化测试替身驱动，不是模型的自主调查
        </p>
      )}
      {modelMode === 'unconfigured' && (
        <p className="flex items-center justify-center gap-2 bg-canvas-2 px-6 py-2 text-center text-meta text-ink-soft">
          <PlugZap aria-hidden className="size-4 shrink-0" />
          未配置模型：可以查看案例，不能启动新的调查
        </p>
      )}
    </>
  );
}

export default function ConsoleLayout({ children }: { readonly children: ReactNode }) {
  return (
    <SessionGate>
      <TopNav />
      <main className="mx-auto max-w-[1240px] px-6 pt-6 pb-14 max-md:px-4 max-md:pt-4">
        {children}
      </main>
    </SessionGate>
  );
}
