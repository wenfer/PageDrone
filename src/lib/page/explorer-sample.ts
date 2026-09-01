/**
 * 注入页面执行：采样当前页面状态（URL/标题/正文/可交互元素 + 稳定选择器）。
 * 自包含：stableSelector 定义在函数体内，供 chrome.scripting 序列化。
 */

export interface PageElementRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageElementPoint {
  x: number;
  y: number;
}

export interface PageElement {
  index: number;
  tag: string;
  type: string;
  role?: string;
  text: string;
  selector: string;
  rect?: PageElementRect;
  center?: PageElementPoint;
  inViewport: boolean;
  disabled?: boolean;
  checked?: boolean;
  value?: string;
  placeholder?: string;
  href?: string;
}

export interface PageViewportInfo {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  totalHeight: number;
  totalWidth: number;
}

export interface PageSampleOptions {
  includeElements?: boolean;
  textMaxLength?: number;
  elementLimit?: number;
  inViewportOnly?: boolean;
  format?: 'detailed' | 'compact' | 'elements_only';
  selectorScope?: string;
}

export interface PageState {
  url: string;
  title: string;
  text: string;
  viewport?: PageViewportInfo;
  elements: PageElement[];
  compactView?: string;
  error?: string;
}

export function samplePageState(options?: PageSampleOptions): PageState {
  const opt: PageSampleOptions = options || {};
  const textMaxLength = Math.min(30000, Math.max(100, Number(opt.textMaxLength) || 2000));
  const elementLimit = Math.min(200, Math.max(1, Number(opt.elementLimit) || 50));
  const inViewportOnly = opt.inViewportOnly === true;
  const selectorScope = String(opt.selectorScope || '').trim();

  function stableSelector(el: Element): string {
    if (el.nodeType !== 1) return '';
    const htmlEl = el as HTMLElement;

    function escapeCss(value: string): string {
      if (window.CSS && typeof CSS.escape === 'function') return CSS.escape(value);
      return value.replace(/[^A-Za-z0-9_-]/g, (char) => `\\${char}`);
    }

    function uniquelySelects(candidate: string, target: Element): boolean {
      try {
        const matches = document.querySelectorAll(candidate);
        return matches.length === 1 && matches[0] === target;
      } catch {
        return false;
      }
    }

    if (htmlEl.id) {
      const byId = `#${escapeCss(htmlEl.id)}`;
      if (uniquelySelects(byId, el)) return byId;
    }

    const tag = htmlEl.tagName.toLowerCase();
    const attrs = ['data-testid', 'name', 'aria-label'];
    for (const a of attrs) {
      const v = htmlEl.getAttribute && htmlEl.getAttribute(a);
      if (v) {
        const byAttr = `${tag}[${a}="${escapeCss(v)}"]`;
        if (uniquelySelects(byAttr, el)) return byAttr;
      }
    }

    const classes =
      htmlEl.className && typeof htmlEl.className === 'string'
        ? htmlEl.className
            .trim()
            .split(/\s+/)
            .filter((c) => c && c.length < 30 && !/\d{4,}/.test(c))
            .slice(0, 3)
        : [];

    if (classes.length) {
      const byClass = `${tag}.${classes.map(escapeCss).join('.')}`;
      if (uniquelySelects(byClass, el)) return byClass;
    }

    const path: string[] = [];
    let current: Element | null = el;
    while (current && current !== document.documentElement) {
      const currentHtml = current as HTMLElement;
      let segment = currentHtml.tagName.toLowerCase();

      if (currentHtml.id) {
        segment = `#${escapeCss(currentHtml.id)}`;
      } else {
        const currentClasses =
          typeof currentHtml.className === 'string'
            ? currentHtml.className
                .trim()
                .split(/\s+/)
                .filter((c) => c && c.length < 30 && !/\d{4,}/.test(c))
                .slice(0, 2)
            : [];
        if (currentClasses.length) {
          segment += `.${currentClasses.map(escapeCss).join('.')}`;
        }

        const parent = current.parentElement;
        if (parent) {
          let siblingCount = 0;
          try {
            siblingCount = Array.from(parent.children).filter((child) => child.matches(segment)).length;
          } catch {
            siblingCount = 0;
          }
          if (siblingCount > 1 || siblingCount === 0) {
            segment += `:nth-child(${Array.from(parent.children).indexOf(current) + 1})`;
          }
        }
      }

      path.unshift(segment);
      const candidate = path.join(' > ');
      if (uniquelySelects(candidate, el)) return candidate;
      if (currentHtml.id) break;
      current = current.parentElement;
    }

    return path.join(' > ') || tag;
  }

  let scopeRoot: Element | Document = document;
  if (selectorScope) {
    try {
      const matched = document.querySelector(selectorScope);
      if (matched) scopeRoot = matched;
    } catch {
      // 忽略非法选择器，默认全局
    }
  }

  const vpWidth = window.innerWidth || document.documentElement.clientWidth || 1024;
  const vpHeight = window.innerHeight || document.documentElement.clientHeight || 768;

  const selectorList = 'a, button, input, textarea, select, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], [role="switch"], [role="menuitem"], [onclick], [tabindex]:not([tabindex="-1"])';
  const candidateElements = Array.from(scopeRoot.querySelectorAll<HTMLElement>(selectorList));

  const sampledList = candidateElements
    .filter((el) => {
      const r = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      
      const isVisible =
        r.width > 0 &&
        r.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        style.pointerEvents !== 'none';

      if (!isVisible) return false;

      if (inViewportOnly) {
        const inView = r.top < vpHeight && r.bottom > 0 && r.left < vpWidth && r.right > 0;
        if (!inView) return false;
      }

      return true;
    })
    .slice(0, elementLimit);

  let elemCounter = 1;
  const elements: PageElement[] = opt.includeElements === false ? [] : sampledList
    .map((el) => {
      const r = el.getBoundingClientRect();
      const inViewport = r.top < vpHeight && r.bottom > 0 && r.left < vpWidth && r.right > 0;
      const type = (el.getAttribute && el.getAttribute('type')) || '';
      const isPassword = type.toLowerCase() === 'password';
      const role = el.getAttribute('role') || undefined;
      const placeholder = el.getAttribute('placeholder') || undefined;
      const disabled = el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true';
      const checked = (el as HTMLInputElement).checked || undefined;
      const href = (el as HTMLAnchorElement).href || el.getAttribute('href') || undefined;

      let value: string | undefined = undefined;
      if (!isPassword) {
        if ('value' in el && typeof (el as HTMLInputElement).value === 'string' && (el as HTMLInputElement).value) {
          value = (el as HTMLInputElement).value.slice(0, 100);
        }
      } else {
        value = '[密码字段]';
      }

      const rawText = isPassword
        ? '[密码字段]'
        : (
            el.innerText ||
            el.getAttribute('aria-label') ||
            placeholder ||
            value ||
            el.getAttribute('title') ||
            ''
          )
            .trim()
            .slice(0, 80);

      const selector = stableSelector(el);
      if (!selector) return null;

      const rect: PageElementRect = {
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height),
      };

      const center: PageElementPoint = {
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
      };

      const item: PageElement = {
        index: elemCounter++,
        tag: el.tagName.toLowerCase(),
        type,
        role,
        text: rawText,
        selector,
        rect,
        center,
        inViewport,
        disabled: disabled || undefined,
        checked,
        value,
        placeholder,
        href: href ? href.slice(0, 120) : undefined,
      };

      return item;
    })
    .filter((e): e is PageElement => e != null);

  const compactLines = elements.map((e) => {
    const parts: string[] = [`[#${e.index}]`, `<${e.tag}${e.type ? ` type="${e.type}"` : ''}${e.role ? ` role="${e.role}"` : ''}>`];
    if (e.text) parts.push(`"${e.text}"`);
    if (e.value && e.value !== e.text) parts.push(`value="${e.value}"`);
    if (e.checked) parts.push('[checked]');
    if (e.disabled) parts.push('[disabled]');
    if (e.inViewport && e.center) {
      parts.push(`@(x:${e.center.x},y:${e.center.y}) [in-view]`);
    } else if (e.center) {
      parts.push(`@(x:${e.center.x},y:${e.center.y}) [scroll-needed]`);
    }
    parts.push(`-> ${e.selector}`);
    return parts.join(' ');
  });

  const viewportInfo: PageViewportInfo = {
    width: vpWidth,
    height: vpHeight,
    scrollX: Math.round(window.scrollX || window.pageXOffset || 0),
    scrollY: Math.round(window.scrollY || window.pageYOffset || 0),
    totalWidth: Math.round(document.documentElement.scrollWidth || vpWidth),
    totalHeight: Math.round(document.documentElement.scrollHeight || vpHeight),
  };

  return {
    url: location.href,
    title: document.title || '',
    text: document.body ? document.body.innerText.slice(0, textMaxLength) : '',
    viewport: viewportInfo,
    elements,
    compactView: compactLines.join('\n'),
  };
}
