'use client';

import { Activity, FlaskConical, LogOut, PlugZap } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { SlidingPill, useSlidingPill } from '../../components/ui.tsx';
import { sendJson } from '../../lib/api.ts';
import { SessionGate, useCan, useSession } from '../../lib/session.tsx';

const LINKS = [
  { href: '/agent', label: 'Agent 对话', current: (path: string) => path.startsWith('/agent') },
  { href: '/', label: '概览', current: (path: string) => path === '/' },
  { href: '/cases', label: '案例', current: (path: string) => path.startsWith('/cases') },
] as const;
const ADMIN_LINK = {
  href: '/admin',
  label: '本地管理',
  current: (path: string) => path.startsWith('/admin'),
} as const;

function TopNav({ wide }: { readonly wide: boolean }) {
  const { session, displayName, csrfToken } = useSession();
  const admin = useCan('administer_local');
  const path = usePathname();
  const links = [...LINKS, ...(admin ? [ADMIN_LINK] : [])];
  const active = links.find((link) => link.current(path))?.href ?? null;
  const { bar, pill } = useSlidingPill<HTMLElement>(active);
  const signOut = async () => {
    await sendJson('/api/session', {}, csrfToken, 'DELETE');
    window.location.assign('/login');
  };
  return (
    <header className="sticky top-0 z-20 bg-canvas/70 backdrop-blur-xl">
      <div
        className={`mx-auto grid min-h-16 ${wide ? 'max-w-[1600px]' : 'max-w-[1240px]'} grid-cols-[1fr_auto_1fr] items-center gap-x-5 gap-y-2 px-6 max-md:grid-cols-[1fr_auto] max-md:px-4 max-md:py-2.5`}
      >
        <Link
          href="/"
          className="inline-flex items-center gap-2.5 justify-self-start text-base font-semibold tracking-[-0.02em]"
        >
          <span
            aria-hidden
            className="grid size-8 place-items-center rounded-[10px] bg-ink text-white"
          >
            <Activity className="size-4" strokeWidth={2.4} />
          </span>
          {displayName}
        </Link>
        <nav
          ref={bar}
          aria-label="主要页面"
          className="relative flex gap-0.5 rounded-full bg-card p-1 shadow-soft max-md:col-span-2 max-md:row-start-2 max-md:overflow-x-auto"
        >
          <SlidingPill pill={pill} className="top-1 h-8 bg-ink" />
          {links.map((link) => {
            const current = link.href === active;
            return (
              <Link
                key={link.href}
                href={link.href}
                data-active={current}
                aria-current={current ? 'page' : undefined}
                className={`relative z-1 inline-flex h-8 shrink-0 items-center rounded-full px-4 text-sm font-medium transition-colors duration-(--duration-fast) ease-smooth-out ${current ? 'text-white' : 'text-ink-soft hover:text-ink'}`}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
        <div className="flex items-center gap-1.5 justify-self-end">
          <span
            className="grid size-8 shrink-0 place-items-center rounded-full bg-violet-wash text-sm font-semibold text-violet-ink uppercase"
            title={`${session.displayName}（${session.principal}）`}
            data-testid="principal"
          >
            <span aria-hidden>{session.displayName.slice(0, 1)}</span>
            <span className="sr-only">
              {session.displayName}（{session.principal}）
            </span>
          </span>
          <button
            type="button"
            onClick={() => void signOut()}
            className="inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-sm font-medium text-ink-soft transition-colors duration-(--duration-quick) hover:bg-card hover:text-ink"
          >
            <LogOut aria-hidden className="size-4" />
            退出
          </button>
        </div>
      </div>
    </header>
  );
}

function ModeBanner() {
  const { modelMode } = useSession();
  if (modelMode === 'scripted_test') {
    return (
      <p
        data-testid="test-mode-banner"
        className="mb-6 flex w-fit items-center gap-2 rounded-full bg-apricot-soft max-sm:rounded-2xl px-4 py-2 text-meta font-medium text-apricot-ink"
      >
        <FlaskConical aria-hidden className="size-4 shrink-0" />
        测试模式：当前由脚本化测试替身驱动，非真实模型自主调查
      </p>
    );
  }
  if (modelMode === 'unconfigured') {
    return (
      <p className="mb-6 flex w-fit items-center gap-2 rounded-full bg-card px-4 py-2 text-meta text-ink-soft shadow-soft">
        <PlugZap aria-hidden className="size-4 shrink-0" />
        尚未配置模型服务：当前仅支持查看案例，无法发起新调查
      </p>
    );
  }
  return null;
}

export default function ConsoleLayout({ children }: { readonly children: ReactNode }) {
  const path = usePathname();
  // The assistant page holds three columns: it uses the width of the screen, and from lg on the
  // height below the navigation, so each column scrolls inside instead of the page.
  const wide = path.startsWith('/agent');
  return (
    <SessionGate>
      <TopNav wide={wide} />
      <main
        className={`mx-auto px-6 pt-6 max-md:px-4 max-md:pt-4 ${wide ? 'max-w-[1600px] pb-6 lg:flex lg:h-[calc(100dvh-4rem)] lg:flex-col' : 'max-w-[1240px] pb-16'}`}
      >
        <ModeBanner />
        {children}
      </main>
    </SessionGate>
  );
}
