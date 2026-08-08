/**
 * 注入页面执行：采样当前页面状态（URL/标题/正文/可交互元素 + 稳定选择器）。
 * 自包含：stableSelector 定义在函数体内，供 chrome.scripting 序列化。
 */

export interface PageElement {
  tag: string;
  type: string;
  text: string;
  selector: string;
}

export interface PageState {
  url: string;
  title: string;
  text: string;
  elements: PageElement[];
  error?: string;
}

export function samplePageState(): PageState {
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

    // 常见站点会给一组按钮复用完全相同的 class。逐级补充父节点和
    // :nth-child，直到 selector 能且只能命中当前元素，避免执行时误点
    // document.querySelector() 返回的第一个同类按钮。
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

  const interactive = Array.from(
    document.querySelectorAll<HTMLElement>(
      'a, button, input, textarea, select, [role="button"], [onclick]'
    )
  )
    .filter((el) => {
      const r = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const disabled =
        el.matches(':disabled') ||
        el.getAttribute('aria-disabled') === 'true' ||
        !!el.closest('[inert]');
      return (
        !disabled &&
        r.width > 0 &&
        r.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        style.pointerEvents !== 'none'
      );
    })
    .slice(0, 40)
    .map((el) => {
      const type = (el.getAttribute && el.getAttribute('type')) || '';
      // 密码字段的 value 绝不能进入页面快照：快照会被探索器和 AI 对话回灌。
      // 只保留字段类型这一条非敏感事实，普通登录仍可据此判断并触发提交。
      const text = type.toLowerCase() === 'password'
        ? '[密码字段]'
        : (
            el.innerText ||
            (el as HTMLInputElement).value ||
            el.getAttribute('placeholder') ||
            el.getAttribute('aria-label') ||
            ''
          )
            .trim()
            .slice(0, 60);
      return {
        tag: el.tagName.toLowerCase(),
        type,
        text,
        selector: stableSelector(el),
      };
    })
    .filter((e) => e.selector);

  return {
    url: location.href,
    title: document.title || '',
    text: document.body ? document.body.innerText.slice(0, 1500) : '',
    elements: interactive,
  };
}
