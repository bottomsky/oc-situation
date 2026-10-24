import { afterEach, expect, it, vi } from 'vitest';
import * as chartVisibility from './app/utils/chartVisibility';

class NodeFixture {
  parentElement: NodeFixture | null = null;
  children: NodeFixture[] = [];
  open = false;
  inert = false;
  style = { display: 'block', visibility: 'visible' };
  checkVisibility: undefined | ((options?: unknown) => boolean);
  constructor(readonly tagName: string) {}
  append(...nodes: NodeFixture[]) {
    for (const node of nodes) {
      node.parentElement = this;
      this.children.push(node);
    }
    return this;
  }
  contains(other: NodeFixture): boolean {
    return other === this || this.children.some((child) => child.contains(other));
  }
  closest(selector: string): NodeFixture | null {
    return selector === '[inert]' && this.inert
      ? this
      : (this.parentElement?.closest(selector) ?? null);
  }
  getClientRects() {
    return { length: 1 };
  }
}
function visible(node: NodeFixture, fullscreen: NodeFixture | null = null) {
  expect(typeof chartVisibility.isChartElementVisible).toBe('function');
  vi.stubGlobal('getComputedStyle', (element: NodeFixture) => element.style);
  return chartVisibility.isChartElementVisible(
    node as unknown as HTMLElement,
    fullscreen as unknown as Element | null,
  );
}
afterEach(() => vi.unstubAllGlobals());

it('closed details内ghost图例即使仍报告rect也不可见，summary及其文本仍可访问', () => {
  const details = new NodeFixture('DETAILS'),
    summary = new NodeFixture('SUMMARY'),
    label = new NodeFixture('SPAN'),
    legend = new NodeFixture('DIV');
  details.append(summary.append(label), legend);
  expect(visible(legend)).toBe(false);
  expect(visible(details)).toBe(true);
  expect(visible(summary)).toBe(true);
  expect(visible(label)).toBe(true);
  details.open = true;
  expect(visible(legend)).toBe(true);
});

it('嵌套details检查所有祖先，内层summary不能越过外层closed状态', () => {
  const outer = new NodeFixture('DETAILS'),
    outerSummary = new NodeFixture('SUMMARY');
  const inner = new NodeFixture('DETAILS'),
    innerSummary = new NodeFixture('SUMMARY'),
    legend = new NodeFixture('DIV');
  outer.append(outerSummary, inner.append(innerSummary, legend));
  expect(visible(inner)).toBe(false);
  expect(visible(innerSummary)).toBe(false);
  outer.open = true;
  expect(visible(innerSummary)).toBe(true);
  expect(visible(legend)).toBe(false);
});

it('标准checkVisibility优先，fallback仍检查visibility/display/inert与全屏归属', () => {
  const full = new NodeFixture('MAIN'),
    element = new NodeFixture('DIV'),
    outside = new NodeFixture('ASIDE');
  full.append(element);
  element.checkVisibility = vi.fn(() => false);
  expect(visible(element, full)).toBe(false);
  expect(element.checkVisibility).toHaveBeenCalledWith({ checkVisibilityCSS: true });
  element.checkVisibility = undefined;
  expect(visible(element, full)).toBe(true);
  expect(visible(outside, full)).toBe(false);
  element.style.visibility = 'hidden';
  expect(visible(element, full)).toBe(false);
  element.style.visibility = 'visible';
  element.style.display = 'none';
  expect(visible(element, full)).toBe(false);
  element.style.display = 'block';
  element.inert = true;
  expect(visible(element, full)).toBe(false);
});
