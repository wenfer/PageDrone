/**
 * 注入页面的采集器（自包含，运行在 isolated content-script world）。
 * 监听捕获阶段的 click 与 change，推导稳定唯一选择器，回流给 SW。
 */

export function pageCollector(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((window as any).__acRecording) return;
  (window as any).__acRecording = true;

  const send = (event: Record<string, unknown>) => {
    if (!(window as any).__acRecording) return;
    try {
      chrome.runtime.sendMessage({ type: 'RECORD_EVENT', event });
    } catch {
      /* SW 可能休眠，忽略单次失败 */
    }
  };

  function cssEsc(s: string): string {
    return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&');
  }

  function isUnique(sel: string): boolean {
    try {
      return document.querySelectorAll(sel).length === 1;
    } catch {
      return false;
    }
  }

  function oneLevelSelector(el: Element): string {
    const htmlEl = el as HTMLElement;
    if (htmlEl.id && /^[A-Za-z][\w-]*$/.test(htmlEl.id)) return `#${cssEsc(htmlEl.id)}`;
    const tag = htmlEl.tagName.toLowerCase();
    for (const a of ['data-testid', 'data-test', 'name', 'aria-label']) {
      const v = htmlEl.getAttribute && htmlEl.getAttribute(a);
      if (v) return `${tag}[${a}="${cssEsc(v)}"]`;
    }
    if (htmlEl.getAttribute && htmlEl.getAttribute('type') && (tag === 'input' || tag === 'button')) {
      const t = htmlEl.getAttribute('type') || '';
      const base = `${tag}[type="${cssEsc(t)}"]`;
      if (isUnique(base)) return base;
    }
    const cls =
      htmlEl.className && typeof htmlEl.className === 'string'
        ? htmlEl.className
            .trim()
            .split(/\s+/)
            .filter((c) => c && c.length < 30 && !/\d{4,}/.test(c))
            .slice(0, 2)
        : [];
    if (cls.length) return `${tag}.${cls.map(cssEsc).join('.')}`;
    return tag;
  }

  function nthOfType(el: Element): string {
    const tag = el.tagName.toLowerCase();
    const parent = el.parentElement;
    if (!parent) return tag;
    const same = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
    return same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(el) + 1})` : tag;
  }

  function uniqueSelector(el: Element | null): string {
    if (!el || el.nodeType !== 1) return '';
    const one = oneLevelSelector(el);
    if (one.startsWith('#') || isUnique(one)) return one;
    let cur: Element | null = el;
    const parts: string[] = [];
    while (cur && cur.nodeType === 1 && cur.tagName.toLowerCase() !== 'html') {
      let seg = oneLevelSelector(cur);
      if (seg.startsWith('#')) {
        parts.unshift(seg);
        break;
      }
      if (!isUnique(seg)) seg = nthOfType(cur);
      parts.unshift(seg);
      const candidate = parts.join(' > ');
      if (isUnique(candidate)) return candidate;
      cur = cur.parentElement;
    }
    return parts.join(' > ') || el.tagName.toLowerCase();
  }

  function labelOf(el: Element): string {
    const h = el as HTMLElement;
    const t = (h.innerText || (h as HTMLInputElement).value || h.getAttribute?.('placeholder') || h.getAttribute?.('aria-label') || '').trim();
    return t.slice(0, 40);
  }

  function mayNavigate(el: Element): boolean {
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' && (el as HTMLAnchorElement).getAttribute('href')) return true;
    const type = ((el as HTMLElement).getAttribute?.('type') || '').toLowerCase();
    if (type === 'submit') return true;
    if (tag === 'button' && el.closest?.('form')) return true;
    return false;
  }

  // —— click 捕获 ——
  document.addEventListener(
    'click',
    (e: Event) => {
      if (!(window as any).__acRecording) return;
      let el = e.target as Element | null;
      if (!el || el.nodeType !== 1) return;
      const clickable = (el.closest?.('a, button, input, textarea, select, [role="button"], [onclick]') || el) as Element;
      const selector = uniqueSelector(clickable);
      if (!selector) return;
      send({ type: 'click', selector, label: labelOf(clickable), navigates: mayNavigate(clickable) });
    },
    true
  );

  // —— 输入捕获 ——
  document.addEventListener(
    'change',
    (e: Event) => {
      if (!(window as any).__acRecording) return;
      const el = e.target as Element | null;
      if (!el || el.nodeType !== 1) return;
      const tag = el.tagName.toLowerCase();
      const type = ((el as HTMLElement).getAttribute?.('type') || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        if (type === 'checkbox' || type === 'radio') {
          send({ type: 'click', selector: uniqueSelector(el), label: labelOf(el), navigates: false });
          return;
        }
        const masked = type === 'password';
        send({ type: 'type', selector: uniqueSelector(el), value: (el as HTMLInputElement).value ?? '', masked });
      }
    },
    true
  );
}