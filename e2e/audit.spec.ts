import { ADMIN, approveOpenContract, value } from '@aftercare/console/testing';
import type { Page } from '@playwright/test';
import {
  APPROVER,
  answerUntilApproval,
  expect,
  OPERATOR,
  reportToAssistant,
  signIn,
  test,
  untilStage,
} from './support.ts';

// Opt-in contrast, overflow, truncation, atomic-amount and app-shell geometry gate.
// Skipped in a normal e2e run unless AFTERCARE_E2E_AUDIT=1.

const AUDIT = process.env.AFTERCARE_E2E_AUDIT;

test.skip(AUDIT === undefined, 'set AFTERCARE_E2E_AUDIT=1 to run contrast and geometry audit');

const VIEWPORTS = [
  { width: 320, height: 664 },
  { width: 390, height: 844 },
  { width: 768, height: 844 },
  { width: 1024, height: 844 },
  { width: 1280, height: 720 },
  { width: 1440, height: 844 },
] as const;

async function settleAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const finite = document.getAnimations().filter((animation) => {
      const timing = animation.effect?.getComputedTiming();
      return timing !== undefined && timing.iterations !== Number.POSITIVE_INFINITY;
    });
    if (finite.length === 0) return;
    await Promise.race([
      Promise.allSettled(finite.map((animation) => animation.finished)),
      new Promise<void>((resolve) => {
        setTimeout(resolve, 1000);
      }),
    ]);
  });
}

/** Paint-stack contrast, overflow, truncation, atomic-currency and app-shell geometry check. */
const MEASURE = () => {
  interface Sample {
    readonly where: string;
    readonly text: string;
    readonly ratio: number;
    readonly size: number;
    readonly weight: number;
  }
  interface AgentGeometry {
    readonly docScrollDelta: number;
    readonly cardBottomDelta: number;
    readonly composerBottomDelta: number;
    readonly scrollerElasticGap: number;
    readonly composerInViewport: boolean;
    readonly scrollerClientHeight: number;
    readonly scrollerScrollHeight: number;
    readonly emptyAssistantRows: number;
    readonly titleHeight: number | null;
    readonly titleLineLimit: number | null;
  }
  type Rgba = readonly [number, number, number, number];

  const parse = (raw: string): Rgba | null => {
    const match = /^rgba?\(([^)]+)\)$/.exec(raw);
    if (match === null) return null;
    const parts = (match[1] ?? '').split(/[,\s/]+/).filter((part) => part !== '');
    const red = Number(parts[0]);
    const green = Number(parts[1]);
    const blue = Number(parts[2]);
    const alpha = parts.length > 3 ? Number(parts[3]) : 1;
    if ([red, green, blue, alpha].some(Number.isNaN)) return null;
    return [red, green, blue, alpha];
  };
  const channel = (component: number): number => {
    const scaled = component / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (rgb: Rgba): number =>
    0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
  const over = (top: Rgba, bottom: Rgba): Rgba => {
    const alpha = top[3];
    return [
      top[0] * alpha + bottom[0] * (1 - alpha),
      top[1] * alpha + bottom[1] * (1 - alpha),
      top[2] * alpha + bottom[2] * (1 - alpha),
      1,
    ];
  };
  const path = (element: Element): string => {
    const parts: string[] = [];
    let node: Element | null = element;
    while (node !== null && parts.length < 4) {
      const id = node.getAttribute('data-testid');
      parts.unshift(id === null ? node.tagName.toLowerCase() : `[${id}]`);
      node = node.parentElement;
    }
    return parts.join('>');
  };
  const isVisibleElement = (element: Element): boolean => {
    let cur: Element | null = element;
    while (cur !== null) {
      const st = getComputedStyle(cur);
      if (st.display === 'none' || st.visibility === 'hidden') return false;
      cur = cur.parentElement;
    }
    return true;
  };
  const effectiveOpacity = (element: Element): number => {
    let acc = 1;
    let cur: Element | null = element;
    while (cur !== null) {
      const op = Number.parseFloat(getComputedStyle(cur).opacity);
      if (!Number.isNaN(op)) acc *= op;
      cur = cur.parentElement;
    }
    return acc;
  };

  const modals = Array.from(document.querySelectorAll('dialog[open]')).filter((dialog) =>
    dialog.matches(':modal'),
  );
  const activeModal = modals.at(-1) ?? null;
  const isOccluded = (element: Element): boolean =>
    activeModal !== null && !activeModal.contains(element);

  // 1. Geometry & structural checks BEFORE any temporary scrollIntoView during contrast sampling.
  const overflow = document.documentElement.scrollWidth - window.innerWidth;

  const dialogOverflows: string[] = [];
  for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog[open]')) {
    if (!isVisibleElement(dialog)) continue;
    if (dialog.scrollWidth > dialog.clientWidth + 1) {
      dialogOverflows.push(`${path(dialog)} (${dialog.scrollWidth} > ${dialog.clientWidth})`);
    }
  }

  const tableOverflows: string[] = [];
  if (window.innerWidth >= 768) {
    for (const table of document.querySelectorAll<HTMLTableElement>('[role="region"] table')) {
      if (isOccluded(table) || !isVisibleElement(table)) continue;
      const region = table.closest<HTMLElement>('[role="region"]');
      if (region === null || region.clientWidth === 0) continue;
      if (table.scrollWidth > region.clientWidth + 1) {
        tableOverflows.push(`${path(table)} (${table.scrollWidth} > ${region.clientWidth})`);
      }
    }
  }

  const truncateFailures: string[] = [];
  for (const element of document.querySelectorAll<HTMLElement>('.truncate')) {
    if (isOccluded(element) || !isVisibleElement(element)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) continue;
    const st = getComputedStyle(element);
    const fontSize = Number.parseFloat(st.fontSize) || 15;
    const rawLh = Number.parseFloat(st.lineHeight);
    const lineHeight = Number.isNaN(rawLh) ? fontSize * 1.5 : rawLh;
    const padY =
      (Number.parseFloat(st.paddingTop) || 0) + (Number.parseFloat(st.paddingBottom) || 0);
    const contentHeight = element.scrollHeight - padY;
    const limit = Math.ceil(lineHeight * 1.35);
    if (contentHeight > limit) {
      truncateFailures.push(
        `${path(element)} (${Math.round(contentHeight)}px > ${limit}px :: ${(element.textContent ?? '').trim().slice(0, 24)})`,
      );
    }
  }

  const amountSplits: string[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let currentText = walker.nextNode();
  while (currentText !== null) {
    const raw = currentText.textContent ?? '';
    const parent = currentText.parentElement;
    if (
      raw.includes('¥') &&
      parent !== null &&
      !isOccluded(parent) &&
      isVisibleElement(parent) &&
      parent.getBoundingClientRect().width >= 4
    ) {
      for (const match of raw.matchAll(/¥\d[\d,.]*/g)) {
        const start = match.index ?? 0;
        const token = match[0];
        const range = document.createRange();
        range.setStart(currentText, start);
        range.setEnd(currentText, start + token.length);
        const rects = Array.from(range.getClientRects()).filter(
          (r) => r.width > 0.5 && r.height > 0.5,
        );
        if (rects.length > 1) {
          amountSplits.push(`${path(parent)} :: ${token} (${rects.length} rects)`);
        }
      }
    }
    currentText = walker.nextNode();
  }

  let agentGeometry: AgentGeometry | null = null;
  if (window.location.pathname.startsWith('/agent')) {
    const scroller = document.querySelector<HTMLElement>('[data-testid="transcript-scroller"]');
    const column = scroller?.parentElement ?? null;
    const section = scroller?.closest('section') ?? null;
    const main = document.querySelector('main');
    const composer = document.querySelector('textarea[name="message"]')?.closest('form') ?? null;
    const titleEl = section?.querySelector('header h1') ?? null;
    const mainRect = main?.getBoundingClientRect();
    const mainPadBottom =
      main === null ? 0 : Number.parseFloat(getComputedStyle(main).paddingBottom) || 0;
    const sectionRect = section?.getBoundingClientRect();
    const sectionPadTop =
      section === null ? 0 : Number.parseFloat(getComputedStyle(section).paddingTop) || 0;
    const sectionPadBottom =
      section === null ? 0 : Number.parseFloat(getComputedStyle(section).paddingBottom) || 0;
    const composerRect = composer?.getBoundingClientRect();
    const nonScrollerHeight =
      column === null
        ? 0
        : Array.from(column.children)
            .filter((child) => child !== scroller)
            .reduce((sum, child) => {
              const cs = getComputedStyle(child);
              const margins =
                (Number.parseFloat(cs.marginTop) || 0) + (Number.parseFloat(cs.marginBottom) || 0);
              return sum + (child as HTMLElement).offsetHeight + margins;
            }, 0);
    const expectedScrollerHeight =
      section === null
        ? 0
        : section.clientHeight - sectionPadTop - sectionPadBottom - nonScrollerHeight;
    const emptyAssistantRows = Array.from(
      document.querySelectorAll('[data-testid="assistant-message"]'),
    ).filter((row) => (row.textContent ?? '').trim() === '').length;
    let titleHeight: number | null = null;
    let titleLineLimit: number | null = null;
    if (titleEl !== null) {
      const ts = getComputedStyle(titleEl);
      const fs = Number.parseFloat(ts.fontSize) || 17;
      const lh = Number.parseFloat(ts.lineHeight);
      titleHeight = Math.round(titleEl.scrollHeight);
      titleLineLimit = Math.ceil((Number.isNaN(lh) ? fs * 1.45 : lh) * 1.35);
    }
    agentGeometry = {
      docScrollDelta: document.documentElement.scrollHeight - window.innerHeight,
      cardBottomDelta:
        mainRect !== undefined && sectionRect !== undefined
          ? Math.round(Math.abs(mainRect.bottom - mainPadBottom - sectionRect.bottom) * 10) / 10
          : 999,
      composerBottomDelta:
        sectionRect !== undefined && composerRect !== undefined
          ? Math.round(Math.abs(sectionRect.bottom - sectionPadBottom - composerRect.bottom) * 10) /
            10
          : 999,
      scrollerElasticGap: Math.round(
        Math.abs(expectedScrollerHeight - (scroller?.clientHeight ?? 0)),
      ),
      composerInViewport:
        composerRect !== undefined &&
        composerRect.top >= -1 &&
        composerRect.bottom <= window.innerHeight + 1,
      scrollerClientHeight: scroller?.clientHeight ?? 0,
      scrollerScrollHeight: scroller?.scrollHeight ?? 0,
      emptyAssistantRows,
      titleHeight,
      titleLineLimit,
    };
  }

  // 2. Paint-stack contrast check (open hit-testing so decorative sibling layers like SlidingPill hit).
  const savedWindowX = window.scrollX;
  const savedWindowY = window.scrollY;
  const savedScrolls = new Map<Element, readonly [number, number]>();
  for (const el of document.querySelectorAll('*')) {
    if (el.scrollTop !== 0 || el.scrollLeft !== 0) {
      savedScrolls.set(el, [el.scrollLeft, el.scrollTop]);
    }
  }
  const auditStyle = document.createElement('style');
  auditStyle.setAttribute('data-audit', '');
  auditStyle.textContent = '* { pointer-events: auto !important; }';
  document.head.appendChild(auditStyle);

  const samples: Sample[] = [];
  const unmeasurableItems: string[] = [];

  try {
    const pseudoLayer = (
      node: Element,
      pseudo: '::before' | '::after',
    ): Rgba | 'unmeasurable' | null => {
      const ps = getComputedStyle(node, pseudo);
      if (
        ps.content === 'none' ||
        ps.content === 'normal' ||
        ps.display === 'none' ||
        ps.visibility === 'hidden'
      ) {
        return null;
      }
      const w = Number.parseFloat(ps.width);
      const h = Number.parseFloat(ps.height);
      const nr = node.getBoundingClientRect();
      if (!Number.isFinite(w) || !Number.isFinite(h) || nr.width <= 0 || nr.height <= 0) {
        return null;
      }
      if (w < nr.width * 0.8 || h < nr.height * 0.8) return null;
      if (ps.backgroundImage !== 'none') return 'unmeasurable';
      const bg = parse(ps.backgroundColor);
      if (bg === null || bg[3] <= 0) return null;
      const op = Number.parseFloat(ps.opacity);
      return [bg[0], bg[1], bg[2], bg[3] * (Number.isNaN(op) ? 1 : op)];
    };

    const resolveBackdrop = (
      element: Element,
      cx: number,
      cy: number,
    ): Rgba | 'unmeasurable' | null => {
      const stack = document.elementsFromPoint(cx, cy);
      const idx = stack.indexOf(element);
      if (idx < 0) return null;
      const layers: Rgba[] = [];
      let remaining = 1;
      for (const node of stack.slice(idx)) {
        const afterLayer = pseudoLayer(node, '::after');
        if (afterLayer === 'unmeasurable') return 'unmeasurable';
        if (afterLayer !== null) {
          layers.push(afterLayer);
          remaining *= 1 - afterLayer[3];
          if (remaining <= 0.001) break;
        }
        const beforeLayer = pseudoLayer(node, '::before');
        if (beforeLayer === 'unmeasurable') return 'unmeasurable';
        if (beforeLayer !== null) {
          layers.push(beforeLayer);
          remaining *= 1 - beforeLayer[3];
          if (remaining <= 0.001) break;
        }
        const st = getComputedStyle(node);
        if (st.backgroundImage !== 'none') return 'unmeasurable';
        const bg = parse(st.backgroundColor);
        if (bg !== null && bg[3] > 0) {
          const op = Number.parseFloat(st.opacity);
          const alpha = bg[3] * (Number.isNaN(op) ? 1 : op);
          if (alpha > 0) {
            layers.push([bg[0], bg[1], bg[2], alpha]);
            remaining *= 1 - alpha;
            if (remaining <= 0.001) break;
          }
        }
      }
      let acc: Rgba = [255, 255, 255, 1];
      for (let i = layers.length - 1; i >= 0; i -= 1) {
        const layer = layers[i];
        if (layer !== undefined) acc = over(layer, acc);
      }
      return acc;
    };

    for (const element of document.querySelectorAll('body *')) {
      if (isOccluded(element)) continue;
      if (element.closest(':disabled, [aria-disabled="true"]') !== null) continue;
      const textNode = Array.from(element.childNodes).find(
        (node): node is Text =>
          node.nodeType === Node.TEXT_NODE && /\S/.test(node.textContent ?? ''),
      );
      if (textNode === undefined) continue;
      const box = element.getBoundingClientRect();
      if (box.width < 4 || box.height < 4) continue;
      if (!isVisibleElement(element)) continue;
      const elOpacity = effectiveOpacity(element);
      if (elOpacity <= 0.01) continue;

      const style = getComputedStyle(element);
      const colour = parse(style.color);
      if (colour === null) continue;

      const raw = textNode.textContent ?? '';
      const firstMatch = /\S/.exec(raw);
      if (firstMatch === null) continue;
      const start = firstMatch.index;
      const glyph = Array.from(raw.slice(start))[0] ?? ' ';
      const range = document.createRange();
      range.setStart(textNode, start);
      range.setEnd(textNode, start + glyph.length);

      let glyphRect = range.getClientRects()[0];
      if (glyphRect === undefined || glyphRect.width === 0 || glyphRect.height === 0) continue;
      let cx = glyphRect.left + glyphRect.width / 2;
      let cy = glyphRect.top + glyphRect.height / 2;

      if (cx < 0 || cy < 0 || cx >= window.innerWidth || cy >= window.innerHeight) {
        element.scrollIntoView({ block: 'center', inline: 'nearest' });
        glyphRect = range.getClientRects()[0];
        if (glyphRect === undefined || glyphRect.width === 0 || glyphRect.height === 0) continue;
        cx = glyphRect.left + glyphRect.width / 2;
        cy = glyphRect.top + glyphRect.height / 2;
        if (cx < 0 || cy < 0 || cx >= window.innerWidth || cy >= window.innerHeight) continue;
      }

      const behind = resolveBackdrop(element, cx, cy);
      if (behind === null) continue;
      if (behind === 'unmeasurable') {
        unmeasurableItems.push(`${path(element)} :: ${raw.trim().slice(0, 32)}`);
        continue;
      }

      const effectiveColour: Rgba = [colour[0], colour[1], colour[2], colour[3] * elOpacity];
      const text = over(effectiveColour, behind);
      const lighter = Math.max(luminance(text), luminance(behind));
      const darker = Math.min(luminance(text), luminance(behind));
      const ratio = (lighter + 0.05) / (darker + 0.05);
      const size = Number.parseFloat(style.fontSize);
      const weight = Number.parseInt(style.fontWeight, 10);
      samples.push({
        where: path(element),
        text: raw.trim().slice(0, 40),
        ratio: Math.round(ratio * 100) / 100,
        size,
        weight,
      });
    }
  } finally {
    auditStyle.remove();
    window.scrollTo(savedWindowX, savedWindowY);
    for (const [el, [left, top]] of savedScrolls) {
      el.scrollLeft = left;
      el.scrollTop = top;
    }
  }

  samples.sort((left, right) => left.ratio - right.ratio);
  const failingSamples = samples.filter((sample) => {
    const large = sample.size >= 24 || (sample.size >= 18.66 && sample.weight >= 700);
    return sample.ratio < (large ? 3 : 4.5);
  });

  return {
    overflow,
    width: window.innerWidth,
    height: window.innerHeight,
    total: samples.length,
    worst: samples.slice(0, 8),
    failures: failingSamples.length,
    failingSamples: failingSamples.slice(0, 12),
    unmeasurable: unmeasurableItems.length,
    unmeasurableItems,
    dialogOverflows,
    tableOverflows,
    truncateFailures,
    amountSplits,
    agentGeometry,
  };
};

async function audit(page: Page, label: string): Promise<void> {
  await settleAnimations(page);
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await settleAnimations(page);
    const result = await page.evaluate(MEASURE);
    const worstRatio = result.worst[0]?.ratio ?? null;
    const agentSummary =
      result.agentGeometry === null
        ? ''
        : ` docDelta=${result.agentGeometry.docScrollDelta}px scroller=${result.agentGeometry.scrollerClientHeight}/${result.agentGeometry.scrollerScrollHeight} composerInView=${result.agentGeometry.composerInViewport} cardDelta=${result.agentGeometry.cardBottomDelta}px emptyMsg=${result.agentGeometry.emptyAssistantRows} titleH=${result.agentGeometry.titleHeight ?? 'n/a'}`;
    process.stdout.write(
      `[${label} @ ${result.width}x${result.height}] overflow=${result.overflow}px contrast=${result.failures}/${result.total} (worst=${worstRatio ?? 'n/a'}) unmeasurable=${result.unmeasurable}${agentSummary}\n`,
    );

    expect(
      result.overflow,
      `${label} overflows sideways at ${viewport.width}x${viewport.height}`,
    ).toBeLessThanOrEqual(1);
    expect(
      result.dialogOverflows,
      `${label} dialog overflows at ${viewport.width}x${viewport.height}`,
    ).toEqual([]);
    expect(
      result.tableOverflows,
      `${label} table overflows region at ${viewport.width}x${viewport.height}`,
    ).toEqual([]);
    expect(
      result.truncateFailures,
      `${label} .truncate wrapped to multiple lines at ${viewport.width}x${viewport.height}`,
    ).toEqual([]);
    expect(
      result.amountSplits,
      `${label} split a currency value across lines at ${viewport.width}x${viewport.height}`,
    ).toEqual([]);
    expect(
      result.unmeasurable,
      `${label} had unmeasurable backgrounds at ${viewport.width}x${viewport.height}: ${result.unmeasurableItems.join('; ')}`,
    ).toBe(0);
    expect(
      result.failures,
      `${label} had WCAG contrast failures at ${viewport.width}x${viewport.height}: ${result.failingSamples.map((s) => `${s.ratio} ${s.where} "${s.text}"`).join('; ')}`,
    ).toBe(0);

    if (result.agentGeometry !== null && viewport.height >= 480) {
      expect(
        result.agentGeometry.docScrollDelta,
        `${label} document scrolled vertically at ${viewport.width}x${viewport.height}`,
      ).toBeLessThanOrEqual(1);
      expect(
        result.agentGeometry.composerInViewport,
        `${label} composer outside viewport at ${viewport.width}x${viewport.height}`,
      ).toBe(true);
      expect(
        result.agentGeometry.cardBottomDelta,
        `${label} conversation card did not fill <main> at ${viewport.width}x${viewport.height}`,
      ).toBeLessThanOrEqual(2);
      expect(
        result.agentGeometry.composerBottomDelta,
        `${label} composer did not align to card bottom at ${viewport.width}x${viewport.height}`,
      ).toBeLessThanOrEqual(2);
      expect(
        result.agentGeometry.scrollerElasticGap,
        `${label} transcript scroller did not fill remaining card height at ${viewport.width}x${viewport.height}`,
      ).toBeLessThanOrEqual(4);
      expect(
        result.agentGeometry.scrollerClientHeight,
        `${label} transcript scroller collapsed at ${viewport.width}x${viewport.height}`,
      ).toBeGreaterThanOrEqual(viewport.height >= 720 ? 180 : 80);
      expect(
        result.agentGeometry.emptyAssistantRows,
        `${label} rendered an empty assistant-message row at ${viewport.width}x${viewport.height}`,
      ).toBe(0);
      if (
        result.agentGeometry.titleHeight !== null &&
        result.agentGeometry.titleLineLimit !== null
      ) {
        expect(
          result.agentGeometry.titleHeight,
          `${label} header title wrapped at ${viewport.width}x${viewport.height}`,
        ).toBeLessThanOrEqual(result.agentGeometry.titleLineLimit);
      }
    }
  }
}

test('measure contrast, overflow, truncation, currency wrapping and app-shell geometry across pages', async ({
  page,
  harness,
}) => {
  await page.goto('/login');
  await expect(page.locator('input[name=principal]')).toBeVisible();
  await audit(page, 'login');

  await signIn(page, OPERATOR.principal);
  await page.goto('/agent');
  await expect(page.locator('textarea[name=message]')).toBeVisible();
  await audit(page, 'agent-empty');

  harness.startWorker();

  const caseId = await reportToAssistant(page, '导入后商品价格异常，帮我处理');
  const agentUrl = page.url();
  await untilStage(page, 'awaiting_answer');
  await audit(page, 'agent');

  await page.goto(`/cases/${caseId}`);
  await page.getByTestId('tab-questions').click();
  await audit(page, 'case-questions');

  await answerUntilApproval(page);
  for (const tab of ['plan', 'execution', 'results'] as const) {
    await page.getByTestId(`tab-${tab}`).click();
    await audit(page, `case-${tab}`);
  }

  await page.goto(agentUrl);
  await untilStage(page, 'awaiting_approval');
  await page.locator('[data-testid=state-attention-pill]').first().click();
  await page.getByTestId('case-drawer').getByTestId('tab-plan').click();
  await audit(page, 'drawer-plan');

  const approver = await harness.signIn(APPROVER.principal);
  value((await approveOpenContract(approver, caseId)).reply);
  await untilStage(page.getByTestId('case-drawer'), 'partially_resolved');
  await page.getByTestId('case-drawer').getByTestId('tab-results').click();
  await expect(page.getByTestId('case-drawer').getByTestId('report')).toBeVisible();
  await audit(page, 'drawer-results');

  await page.goto('/cases');
  await audit(page, 'cases');
  await page.goto('/');
  await audit(page, 'overview');
  await signIn(page, ADMIN);
  await page.goto('/admin');
  await audit(page, 'admin');
});
