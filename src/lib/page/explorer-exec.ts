/**
 * 注入页面执行探索操作（自包含，CSS + XPath）。
 */

export interface PageActionResult {
  ok: boolean;
  message: string;
  evidence?: {
    selector?: string;
    target?: string;
    href?: string;
    targetBlank?: boolean;
    matchCount?: number;
    clickEventDispatched?: boolean;
    valueApplied?: boolean;
    keyDispatched?: string;
    scrolled?: boolean;
    selectedOption?: string;
    coordinates?: { x: number; y: number };
  };
}

export interface ExecStep {
  type: string;
  selector?: string;
  text?: string;
  includes?: string;
  key?: string;
  modifiers?: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean };
  direction?: 'up' | 'down' | 'left' | 'right' | 'top' | 'bottom' | 'toElement';
  distance?: number;
  value?: string;
  label?: string;
  index?: number;
  x?: number;
  y?: number;
  timeoutMs?: number;
}

export function execPageAction(step: ExecStep): Promise<PageActionResult> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  function findMatches(selector?: string): Element[] {
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

  function findEl(selector?: string): Element | null {
    return findMatches(selector)[0] || null;
  }

  return (async () => {
    try {
      const t = step.type;

      // —— 1. 点击元素 ——
      if (t === 'click') {
        const sel = step.selector || '';
        const start = Date.now();
        let el: Element | null = null;
        while (Date.now() - start < (step.timeoutMs || 10000) && !(el = findEl(sel))) {
          await sleep(200);
        }
        if (!el) return { ok: false, message: `未找到元素：${sel}` };
        const matches = findMatches(sel);
        if (matches.length !== 1 || matches[0] !== el) {
          return {
            ok: false,
            message: `选择器必须唯一，当前匹配 ${matches.length} 个元素：${sel}`,
            evidence: { selector: sel, matchCount: matches.length },
          };
        }
        if (!el.isConnected) return { ok: false, message: `元素已失效：${sel}` };
        if (
          el.matches(':disabled') ||
          el.getAttribute('aria-disabled') === 'true' ||
          el.closest('[inert]')
        ) {
          return { ok: false, message: `元素不可点击（已禁用）：${sel}` };
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
          return { ok: false, message: `元素不可点击（不可见或不接收指针事件）：${sel}` };
        }

        const x = Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2));
        const y = Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2));
        const hit = document.elementFromPoint(x, y);
        if (hit && hit !== el && !el.contains(hit)) {
          return {
            ok: false,
            message: `元素被其他内容遮挡：${sel}（命中 ${hit.tagName.toLowerCase()}）`,
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
                selector: sel,
                target: targetLabel,
                ...(href ? { href } : {}),
                ...(targetBlank ? { targetBlank: true } : {}),
                matchCount: 1,
                clickEventDispatched: true,
              },
            }
          : {
              ok: false,
              message: `页面未接受点击：${sel}`,
              evidence: {
                selector: sel,
                target: targetLabel,
                ...(href ? { href } : {}),
                ...(targetBlank ? { targetBlank: true } : {}),
                matchCount: 1,
                clickEventDispatched: false,
              },
            };
      }

      // —— 2. 悬停元素（Hover） ——
      if (t === 'hover') {
        const sel = step.selector || '';
        const start = Date.now();
        let el: Element | null = null;
        while (Date.now() - start < (step.timeoutMs || 10000) && !(el = findEl(sel))) {
          await sleep(200);
        }
        if (!el) return { ok: false, message: `未找到元素：${sel}` };
        const target = el as HTMLElement;
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        await sleep(50);
        const rect = el.getBoundingClientRect();
        const x = Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2));
        const y = Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2));

        const mouseBase: MouseEventInit = {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: window,
          clientX: x,
          clientY: y,
        };

        if (typeof PointerEvent === 'function') {
          target.dispatchEvent(new PointerEvent('pointerover', { ...mouseBase, pointerId: 1, pointerType: 'mouse' }));
          target.dispatchEvent(new PointerEvent('pointerenter', { ...mouseBase, pointerId: 1, pointerType: 'mouse' }));
          target.dispatchEvent(new PointerEvent('pointermove', { ...mouseBase, pointerId: 1, pointerType: 'mouse' }));
        }
        target.dispatchEvent(new MouseEvent('mouseover', mouseBase));
        target.dispatchEvent(new MouseEvent('mouseenter', mouseBase));
        target.dispatchEvent(new MouseEvent('mousemove', mouseBase));

        await sleep(150); // 给页面展开浮层/二级菜单留出渲染时间
        return {
          ok: true,
          message: `鼠标已悬停于元素：${sel}`,
          evidence: { selector: sel, coordinates: { x: Math.round(x), y: Math.round(y) } },
        };
      }

      // —— 3. 输入文本 ——
      if (t === 'type') {
        const sel = step.selector || '';
        const matches = findMatches(sel);
        const el = matches[0];
        if (!el) return { ok: false, message: `未找到输入框：${sel}` };
        if (matches.length !== 1) {
          return {
            ok: false,
            message: `选择器必须唯一，当前匹配 ${matches.length} 个输入框：${sel}`,
            evidence: { selector: sel, matchCount: matches.length },
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
            selector: sel,
            target: el.tagName.toLowerCase(),
            matchCount: 1,
            valueApplied,
          },
        };
      }

      // —— 4. 清空输入框（Clear） ——
      if (t === 'clear') {
        const sel = step.selector || '';
        const el = findEl(sel);
        if (!el) return { ok: false, message: `未找到输入框：${sel}` };
        const target = el as HTMLElement;
        target.focus?.();
        if ('value' in el) (el as HTMLInputElement).value = '';
        else el.textContent = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return {
          ok: true,
          message: `已清空输入框内容：${sel}`,
          evidence: { selector: sel },
        };
      }

      // —— 5. 键盘按键（Press Key） ——
      if (t === 'pressKey') {
        const rawKey = String(step.key || 'Enter').trim();
        let targetEl: Element | null = null;
        if (step.selector) {
          targetEl = findEl(step.selector);
        }
        if (!targetEl) {
          targetEl = document.activeElement || document.body;
        }

        const mods = step.modifiers || {};
        const keyInit: KeyboardEventInit = {
          key: rawKey,
          code: rawKey === 'Enter' ? 'Enter' : rawKey === 'Escape' ? 'Escape' : rawKey === 'Tab' ? 'Tab' : rawKey === ' ' ? 'Space' : rawKey,
          bubbles: true,
          cancelable: true,
          composed: true,
          view: window,
          ctrlKey: !!mods.ctrl,
          altKey: !!mods.alt,
          shiftKey: !!mods.shift,
          metaKey: !!mods.meta,
        };

        targetEl.dispatchEvent(new KeyboardEvent('keydown', keyInit));
        targetEl.dispatchEvent(new KeyboardEvent('keypress', keyInit));
        targetEl.dispatchEvent(new KeyboardEvent('keyup', keyInit));

        if (rawKey === 'Enter' && targetEl instanceof HTMLInputElement) {
          const form = targetEl.form;
          if (form && typeof form.requestSubmit === 'function') {
            form.requestSubmit();
          }
        }

        return {
          ok: true,
          message: `已派发键盘按键 "${rawKey}"`,
          evidence: { keyDispatched: rawKey },
        };
      }

      // —— 6. 滚动页面或元素（Scroll） ——
      if (t === 'scroll') {
        const dir = step.direction || 'down';
        const dist = Math.min(10000, Math.max(1, Number(step.distance) || 500));
        let container: Element | Window = window;
        let isWindow = true;

        if (step.selector) {
          const matched = findEl(step.selector);
          if (matched) {
            if (dir === 'toElement') {
              matched.scrollIntoView({ behavior: 'smooth', block: 'center' });
              await sleep(200);
              return { ok: true, message: `已将元素滚动至视口：${step.selector}`, evidence: { scrolled: true } };
            }
            container = matched;
            isWindow = false;
          }
        }

        if (isWindow) {
          if (dir === 'top') window.scrollTo({ top: 0, behavior: 'smooth' });
          else if (dir === 'bottom') window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
          else if (dir === 'up') window.scrollBy({ top: -dist, behavior: 'smooth' });
          else if (dir === 'down') window.scrollBy({ top: dist, behavior: 'smooth' });
          else if (dir === 'left') window.scrollBy({ left: -dist, behavior: 'smooth' });
          else if (dir === 'right') window.scrollBy({ left: dist, behavior: 'smooth' });
        } else {
          const elem = container as Element;
          if (dir === 'top') elem.scrollTop = 0;
          else if (dir === 'bottom') elem.scrollTop = elem.scrollHeight;
          else if (dir === 'up') elem.scrollTop -= dist;
          else if (dir === 'down') elem.scrollTop += dist;
          else if (dir === 'left') elem.scrollLeft -= dist;
          else if (dir === 'right') elem.scrollLeft += dist;
        }

        await sleep(200);
        return {
          ok: true,
          message: `已向 ${dir} 滚动 ${dir === 'top' || dir === 'bottom' ? '全页' : `${dist}px`}`,
          evidence: { scrolled: true },
        };
      }

      // —— 7. 下拉选择（Select Option） ——
      if (t === 'selectOption') {
        const sel = step.selector || '';
        const el = findEl(sel);
        if (!el) return { ok: false, message: `未找到下拉框元素：${sel}` };
        if (!(el instanceof HTMLSelectElement)) {
          return { ok: false, message: `元素不是 <select> 标签：${sel}` };
        }

        let matched = false;
        let selectedValue = '';
        const targetValue = step.value !== undefined ? String(step.value) : undefined;
        const targetLabel = step.label !== undefined ? String(step.label) : undefined;
        const targetIndex = step.index !== undefined ? Number(step.index) : undefined;

        for (let i = 0; i < el.options.length; i++) {
          const opt = el.options[i];
          if (!opt) continue;
          const matchValue = targetValue !== undefined && opt.value === targetValue;
          const matchLabel = targetLabel !== undefined && (opt.text === targetLabel || opt.label === targetLabel);
          const matchIndex = targetIndex !== undefined && i === targetIndex;
          if (matchValue || matchLabel || matchIndex) {
            el.selectedIndex = i;
            opt.selected = true;
            selectedValue = opt.value;
            matched = true;
            break;
          }
        }

        if (!matched) {
          return { ok: false, message: `未能匹配到对应选项（value: ${targetValue}, label: ${targetLabel}, index: ${targetIndex}）` };
        }

        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return {
          ok: true,
          message: `已选择下拉选项：${selectedValue}`,
          evidence: { selector: sel, selectedOption: selectedValue },
        };
      }

      // —— 8. 坐标直接点击（Click Coordinate） ——
      if (t === 'clickCoordinate') {
        const x = Math.max(0, Math.min(window.innerWidth - 1, Number(step.x) || 0));
        const y = Math.max(0, Math.min(window.innerHeight - 1, Number(step.y) || 0));
        const hit = document.elementFromPoint(x, y) || document.body;

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
          hit.dispatchEvent(new PointerEvent('pointerdown', { ...mouseBase, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
        }
        hit.dispatchEvent(new MouseEvent('mousedown', { ...mouseBase, buttons: 1 }));
        if (typeof PointerEvent === 'function') {
          hit.dispatchEvent(new PointerEvent('pointerup', { ...mouseBase, buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
        }
        hit.dispatchEvent(new MouseEvent('mouseup', { ...mouseBase, buttons: 0 }));
        hit.dispatchEvent(new MouseEvent('click', mouseBase));

        return {
          ok: true,
          message: `已向坐标 (${Math.round(x)}, ${Math.round(y)}) 派发点击，命中 ${hit.tagName.toLowerCase()}`,
          evidence: { coordinates: { x: Math.round(x), y: Math.round(y) }, target: hit.tagName.toLowerCase(), clickEventDispatched: true },
        };
      }

      // —— 9. 等待 ——
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
