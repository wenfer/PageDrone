/**
 * 注入页面执行探索操作（自包含，CSS + XPath）。
 */

export interface PageActionResult {
  ok: boolean;
  message: string;
  evidence?: {
    selector: string;
    target?: string;
    href?: string;
    targetBlank?: boolean;
    matchCount?: number;
    clickEventDispatched?: boolean;
    valueApplied?: boolean;
  };
}

interface ExecStep {
  type: string;
  selector: string;
  text?: string;
  includes?: string;
  timeoutMs?: number;
}

export function execPageAction(step: ExecStep): Promise<PageActionResult> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  function findMatches(selector: string): Element[] {
    if (!selector) return [];
    const raw = String(selector).trim();
    const isXPath = /^xpath\s*:/i.test(raw) || /^\s*(\/\/|\.\/\/|\(\/\/)/.test(raw) || /^\s*\/html\b/i.test(raw);
    if (isXPath) {
      const expr = raw.replace(/^xpath\s*:/i, '').trim();
      try {
        const result = document.evaluate(
          expr,
          document,
          null,
          XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
          null
        );
        const matches: Element[] = [];
        for (let i = 0; i < result.snapshotLength; i++) {
          const node = result.snapshotItem(i);
          if (node instanceof Element) matches.push(node);
        }
        return matches;
      } catch {
        return [];
      }
    }
    try {
      return Array.from(document.querySelectorAll(raw));
    } catch {
      return [];
    }
  }

  function findEl(selector: string): Element | null {
    return findMatches(selector)[0] || null;
  }

  return (async () => {
    try {
      const t = step.type;
      if (t === 'click') {
        const start = Date.now();
        let el: Element | null = null;
        while (Date.now() - start < (step.timeoutMs || 10000) && !(el = findEl(step.selector))) {
          await sleep(200);
        }
        if (!el) return { ok: false, message: `未找到元素：${step.selector}` };
        const matches = findMatches(step.selector);
        if (matches.length !== 1 || matches[0] !== el) {
          return {
            ok: false,
            message: `选择器必须唯一，当前匹配 ${matches.length} 个元素：${step.selector}`,
            evidence: { selector: step.selector, matchCount: matches.length },
          };
        }
        if (!el.isConnected) return { ok: false, message: `元素已失效：${step.selector}` };
        if (
          el.matches(':disabled') ||
          el.getAttribute('aria-disabled') === 'true' ||
          el.closest('[inert]')
        ) {
          return { ok: false, message: `元素不可点击（已禁用）：${step.selector}` };
        }

        el.scrollIntoView({ block: 'center', inline: 'center' });
        await sleep(80);

        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        if (
          rect.width <= 0 ||
          rect.height <= 0 ||
          style.visibility === 'hidden' ||
          style.display === 'none' ||
          style.pointerEvents === 'none'
        ) {
          return { ok: false, message: `元素不可点击（不可见或不接收指针事件）：${step.selector}` };
        }

        const x = Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2));
        const y = Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2));
        const hit = document.elementFromPoint(x, y);
        if (hit && hit !== el && !el.contains(hit)) {
          return {
            ok: false,
            message: `元素被其他内容遮挡：${step.selector}（命中 ${hit.tagName.toLowerCase()}）`,
          };
        }

        const target = el as HTMLElement;
        const link = el.closest('a') as HTMLAnchorElement | null;
        const href = link?.href || el.getAttribute('href') || '';
        const targetBlank = (link?.target || el.getAttribute('target') || '').toLowerCase() === '_blank';
        target.focus?.({ preventScroll: true });
        const targetLabel = [
          el.tagName.toLowerCase(),
          el.id ? `#${el.id}` : '',
          (target.innerText || target.getAttribute('aria-label') || '').trim().slice(0, 60),
        ]
          .filter(Boolean)
          .join(' ');

        // HTMLElement.click() 只派发 click；部分组件把实际逻辑绑定在
        // pointerdown/mousedown。补齐真实鼠标点击的前置事件序列，同时仍由
        // click() 产生唯一一次 click 事件，避免重复提交。
        const mouseBase: MouseEventInit = {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: window,
          clientX: x,
          clientY: y,
          button: 0,
        };
        if (typeof PointerEvent === 'function') {
          target.dispatchEvent(
            new PointerEvent('pointerdown', {
              ...mouseBase,
              buttons: 1,
              pointerId: 1,
              pointerType: 'mouse',
              isPrimary: true,
            })
          );
        }
        target.dispatchEvent(new MouseEvent('mousedown', { ...mouseBase, buttons: 1 }));
        if (typeof PointerEvent === 'function') {
          target.dispatchEvent(
            new PointerEvent('pointerup', {
              ...mouseBase,
              buttons: 0,
              pointerId: 1,
              pointerType: 'mouse',
              isPrimary: true,
            })
          );
        }
        target.dispatchEvent(new MouseEvent('mouseup', { ...mouseBase, buttons: 0 }));

        let clickObserved = false;
        const observeClick = (event: Event) => {
          const eventTarget = event.target;
          if (eventTarget === el || (eventTarget instanceof Node && el.contains(eventTarget))) {
            clickObserved = true;
          }
        };
        document.addEventListener('click', observeClick, true);
        try {
          if (typeof target.click === 'function') target.click();
          else target.dispatchEvent(new MouseEvent('click', mouseBase));
        } finally {
          document.removeEventListener('click', observeClick, true);
        }

        return clickObserved
          ? {
              ok: true,
              message: '点击事件已派发，业务结果待页面状态确认',
              evidence: {
                selector: step.selector,
                target: targetLabel,
                ...(href ? { href } : {}),
                ...(targetBlank ? { targetBlank: true } : {}),
                matchCount: 1,
                clickEventDispatched: true,
              },
            }
          : {
              ok: false,
              message: `页面未接受点击：${step.selector}`,
              evidence: {
                selector: step.selector,
                target: targetLabel,
                ...(href ? { href } : {}),
                ...(targetBlank ? { targetBlank: true } : {}),
                matchCount: 1,
                clickEventDispatched: false,
              },
            };
      }
      if (t === 'type') {
        const matches = findMatches(step.selector);
        const el = matches[0];
        if (!el) return { ok: false, message: `未找到输入框：${step.selector}` };
        if (matches.length !== 1) {
          return {
            ok: false,
            message: `选择器必须唯一，当前匹配 ${matches.length} 个输入框：${step.selector}`,
            evidence: { selector: step.selector, matchCount: matches.length },
          };
        }
        const target = el as HTMLElement;
        target.focus?.();
        if ('value' in el) (el as HTMLInputElement).value = step.text ?? '';
        else el.textContent = step.text ?? '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        const actual = 'value' in el ? (el as HTMLInputElement).value : el.textContent || '';
        const valueApplied = actual === (step.text ?? '');
        return {
          ok: valueApplied,
          message: valueApplied ? '输入值已写入并派发 input/change 事件' : '输入值写入后校验不一致',
          evidence: {
            selector: step.selector,
            target: el.tagName.toLowerCase(),
            matchCount: 1,
            valueApplied,
          },
        };
      }
      if (t === 'waitFor') {
        const start = Date.now();
        while (Date.now() - start < (step.timeoutMs || 15000)) {
          if (findEl(step.selector)) return { ok: true, message: 'appeared' };
          await sleep(250);
        }
        return { ok: false, message: `等待元素超时：${step.selector}` };
      }
      if (t === 'waitForText') {
        const start = Date.now();
        while (Date.now() - start < (step.timeoutMs || 15000)) {
          const el = (step.selector && step.selector !== 'body' ? findEl(step.selector) : null) || document.body;
          const text = (el as HTMLElement | null)?.innerText || el?.textContent || '';
          if (text.includes(step.includes ?? '')) return { ok: true, message: 'text found' };
          await sleep(250);
        }
        return { ok: false, message: `等待文本超时：${step.includes ?? ''}` };
      }
      return { ok: false, message: `未知步骤：${t}` };
    } catch (e) {
      return { ok: false, message: (e as Error)?.message || String(e) };
    }
  })();
}
