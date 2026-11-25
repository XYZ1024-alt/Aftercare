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
    <header className="sticky top-0 z-30 shrink-0 border-b border-line-subtle bg-canvas/70 backdrop-blur-xl">
      <div
        className={`mx-auto grid min-h-16 ${wide ? 'max-w-[1600px]' : 'max-w-[1240px]'} grid-cols-[1fr_auto_1fr] items-center gap-x-5 gap-y-2 px-6 max-md:grid-cols-[1fr_auto] max-md:px-4 max-md:py-2.5`}
      >
        <Link
          href="/"
          className="inline-flex items-center gap-2.5 justify-self-start text-heading font-semibold tracking-tight"
        >
          <span
            aria-hidden
            className="grid size-8 place-items-center rounded-field bg-ink text-white"
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
          <SlidingPill pill={pill} className="top-1 bottom-1 bg-ink forced-colors:hidden" />
          {links.map((link) => {
            const current = link.href === active;
            return (
              <Link
                key={link.href}
                href={link.href}
                data-active={current}
                aria-current={current ? 'page' : undefined}
                className={`relative z-1 inline-flex min-h-8 shrink-0 items-center rounded-full px-4 py-1 text-meta font-medium transition-colors duration-(--duration-fast) ease-smooth-out aria-[current=page]:forced-colors:outline-2 aria-[current=page]:forced-colors:outline-offset-1 aria-[current=page]:forced-colors:outline-[Highlight] ${current ? 'text-white' : 'text-ink-soft hover:text-ink'}`}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
        <div className="flex items-center gap-1.5 justify-self-end">
          <span
            className="grid size-8 shrink-0 place-items-center rounded-full bg-violet-wash text-meta font-semibold text-violet-ink uppercase"
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
            className="inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 py-1.5 text-meta font-medium text-ink-soft transition-colors duration-(--duration-quick) hover:bg-card hover:text-ink"
          >
            <LogOut aria-hidden className="size-4" />
            退出
          </button>
        </div>
      </div>
    </header>
  );
}

function ModeBanner({ compact = false }: { readonly compact?: boolean }) {
  const { modelMode } = useSession();
  const spacing = compact
    ? 'mb-3 shrink-0 py-1.5 max-sm:mb-2 max-sm:px-3 max-sm:py-1'
    : 'mb-6 py-2';
  if (modelMode === 'scripted_test') {
    return (
      <p
        data-testid="test-mode-banner"
        className={`flex w-fit items-center gap-2 rounded-full border border-apricot-line bg-apricot-soft px-4 text-meta font-medium text-apricot-ink max-sm:rounded-field ${spacing}`}
      >
        <FlaskConical aria-hidden className="size-4 shrink-0" />
        测试模式：当前由脚本化测试替身驱动，非真实模型自主调查
      </p>
    );
  }
  if (modelMode === 'unconfigured') {
    return (
      <p
        className={`flex w-fit items-center gap-2 rounded-full border border-line-subtle bg-subtle px-4 text-meta text-ink-soft max-sm:rounded-field ${spacing}`}
      >
        <PlugZap aria-hidden className="size-4 shrink-0" />
        尚未配置模型服务：当前仅支持查看案例，无法发起新调查
      </p>
    );
  }
  return null;
}

export default function ConsoleLayout({ children }: { readonly children: ReactNode }) {
  const path = usePathname();
  // The assistant page is an app shell across all breakpoints: the viewport stays fixed
  // and only the transcript and sidebar scroll internally.
  const wide = path.startsWith('/agent');
  return (
    <SessionGate>
      {wide ? (
        <div className="flex h-dvh min-h-[480px] flex-col overflow-hidden">
          <TopNav wide />
          <main className="mx-auto flex min-h-0 w-full max-w-[1600px] flex-1 flex-col px-6 py-4 max-md:px-3 max-md:py-2.5">
            <ModeBanner compact />
            {children}
          </main>
        </div>
      ) : (
        <>
          <TopNav wide={false} />
          <main className="mx-auto max-w-[1240px] px-6 pt-6 pb-16 max-md:px-4 max-md:pt-4">
            <ModeBanner />
            {children}
          </main>
        </>
      )}
    </SessionGate>
  );
}
