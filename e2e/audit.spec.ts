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

// Opt-in measurement of what the style overhaul is for: text too faint to read
// and layouts that overflow sideways. Skipped in a normal e2e run.

const AUDIT = process.env.AFTERCARE_E2E_AUDIT;

test.skip(AUDIT === undefined, 'set AFTERCARE_E2E_AUDIT=1 to measure contrast and overflow');

const WIDTHS = [320, 390, 768, 1440] as const;

/** Every visible text run, its resolved colours, and the width of the document. */
const MEASURE = () => {
  interface Sample {
    readonly where: string;
    readonly text: string;
    readonly ratio: number;
    readonly size: number;
    readonly weight: number;
  }
  type Rgba = readonly [number, number, number, number];
  const parse = (value: string): Rgba | null => {
    const match = /^rgba?\(([^)]+)\)$/.exec(value);
    if (match === null) return null;
    const parts = (match[1] ?? '').split(/[,\s/]+/).filter((part) => part !== '');
    const red = Number(parts[0]);
    const green = Number(parts[1]);
    const blue = Number(parts[2]);
    const alpha = parts.length > 3 ? Number(parts[3]) : 1;
    if ([red, green, blue, alpha].some(Number.isNaN)) return null;
    return [red, green, blue, alpha];
  };
  const channel = (value: number): number => {
    const scaled = value / 255;
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
  // The opaque colour behind an element, walking up to the root.
  const backdrop = (start: Element): Rgba => {
    let acc: Rgba = [255, 255, 255, 1];
    const stack: Rgba[] = [];
    for (let node: Element | null = start; node !== null; node = node.parentElement) {
      const parsed = parse(getComputedStyle(node).backgroundColor);
      if (parsed !== null && parsed[3] > 0) {
        stack.push(parsed);
        if (parsed[3] >= 1) break;
      }
    }
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      const layer = stack[index];
      if (layer !== undefined) acc = over(layer, acc);
    }
    return acc;
  };
  const path = (element: Element): string => {
    const parts: string[] = [];
    let node: Element | null = element;
    while (node !== null && parts.length < 4) {
      const id = node.getAttribute('data-testid');
      parts.unshift(id === null ? node.tagName.toLowerCase() : '[' + id + ']');
      node = node.parentElement;
    }
    return parts.join('>');
  };
  const samples: Sample[] = [];
  for (const element of document.querySelectorAll('body *')) {
    const own = Array.from(element.childNodes).some(
      (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '',
    );
    if (!own) continue;
    const box = element.getBoundingClientRect();
    if (box.width < 4 || box.height < 4) continue;
    const style = getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    if (Number.parseFloat(style.opacity) < 0.5) continue;
    const colour = parse(style.color);
    if (colour === null) continue;
    const size = Number.parseFloat(style.fontSize);
    const weight = Number.parseInt(style.fontWeight, 10);
    const behind = backdrop(element);
    const text = over(colour, behind);
    const lighter = Math.max(luminance(text), luminance(behind));
    const darker = Math.min(luminance(text), luminance(behind));
    const ratio = (lighter + 0.05) / (darker + 0.05);
    samples.push({
      where: path(element),
      text: (element.textContent ?? '').trim().slice(0, 40),
      ratio: Math.round(ratio * 100) / 100,
      size,
      weight,
    });
  }
  samples.sort((left, right) => left.ratio - right.ratio);
  return {
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    width: window.innerWidth,
    total: samples.length,
    worst: samples.slice(0, 12),
    failures: samples.filter((sample) => {
      const large = sample.size >= 24 || (sample.size >= 18.66 && sample.weight >= 700);
      return sample.ratio < (large ? 3 : 4.5);
    }).length,
  };
};

async function audit(page: Page, label: string): Promise<void> {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    const result = await page.evaluate(MEASURE);
    const lines = result.worst.map(
      (sample) =>
        '    ' +
        String(sample.ratio).padEnd(6) +
        String(sample.size).padEnd(6) +
        sample.where +
        ' :: ' +
        sample.text,
    );
    process.stdout.write(
      '\n[' +
        label +
        ' @ ' +
        String(result.width) +
        'px] overflow=' +
        String(result.overflow) +
        'px contrast-failures=' +
        String(result.failures) +
        '/' +
        String(result.total) +
        '\n' +
        lines.join('\n') +
        '\n',
    );
    expect(
      result.overflow,
      label + ' overflows sideways at ' + String(width) + 'px',
    ).toBeLessThanOrEqual(1);
  }
}

test('measure contrast and horizontal overflow across pages', async ({ page, harness }) => {
  await page.goto('/login');
  await expect(page.locator('input[name=principal]')).toBeVisible();
  await audit(page, 'login');

  await signIn(page, OPERATOR.principal);
  harness.startWorker();

  const caseId = await reportToAssistant(page, '导入后商品价格异常，帮我处理');
  const agentUrl = page.url();
  await untilStage(page, 'awaiting_answer');
  await audit(page, 'agent');

  await page.goto('/cases/' + caseId);
  await page.getByTestId('tab-questions').click();
  await audit(page, 'case-questions');

  await answerUntilApproval(page);
  for (const tab of ['plan', 'execution', 'results'] as const) {
    await page.getByTestId('tab-' + tab).click();
    await audit(page, 'case-' + tab);
  }

  await page.goto(agentUrl);
  await untilStage(page, 'awaiting_approval');
  await page.locator('[data-testid=state-attention-pill]').first().click();
  await page.getByTestId('case-drawer').getByTestId('tab-plan').click();
  await audit(page, 'drawer-plan');

  const approver = await harness.signIn(APPROVER.principal);
  value((await approveOpenContract(approver, caseId)).reply);
  await page.getByTestId('case-drawer').getByTestId('tab-results').click();
  await audit(page, 'drawer-results');

  await page.goto('/cases');
  await audit(page, 'cases');
  await page.goto('/');
  await audit(page, 'overview');
  await signIn(page, ADMIN);
  await page.goto('/admin');
  await audit(page, 'admin');
});
