/**
 * Read structured data from the currently loaded page.
 *
 * This function is injected with chrome.scripting.executeScript, therefore it
 * deliberately has no imports or references to module scope. Keep all helpers
 * inside the function so the generated bundle remains self-contained.
 */
export interface PageExtractOptions {
  selector: string;
  mode?: 'text' | 'attribute' | 'html' | 'value' | 'list' | 'table';
  attribute?: string;
  multiple?: boolean;
}

export interface PageExtractResult {
  ok: boolean;
  data?: unknown;
  count: number;
  message: string;
}

export function pageExtractData(options: PageExtractOptions): PageExtractResult {
  const inputSelector = String(options?.selector || '').trim();
  const explicitXPath = /^xpath\s*:/i.test(inputSelector);
  const selector = inputSelector.replace(/^(?:xpath|css)\s*:/i, '').trim();
  if (!selector) return { ok: false, count: 0, message: '提取选择器不能为空' };

  const mode = options?.mode || 'text';
  const multiple = options?.multiple !== false || mode === 'list' || mode === 'table';
  const attr = String(options?.attribute || '').trim();

  const query = (root: Document | Element): Element[] => {
    if (explicitXPath || selector.startsWith('/') || selector.startsWith('(')) {
      try {
        const result = document.evaluate(
          selector,
          root,
          null,
          XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
          null,
        );
        const nodes: Element[] = [];
        for (let i = 0; i < result.snapshotLength; i += 1) {
          const node = result.snapshotItem(i);
          if (node instanceof Element) nodes.push(node);
        }
        return nodes;
      } catch {
        return [];
      }
    }
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch {
      return [];
    }
  };

  const elements = query(document);
  if (!elements.length) {
    return { ok: false, count: 0, message: `未找到元素：${selector}` };
  }

  const textOf = (element: Element): string =>
    (element.textContent || '').replace(/\s+/g, ' ').trim();
  const valueOf = (element: Element): unknown => {
    if (mode === 'attribute') return attr ? element.getAttribute(attr) : null;
    if (mode === 'html') return element.innerHTML;
    if (mode === 'value') {
      const input = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      return 'value' in input ? String(input.value ?? '') : textOf(element);
    }
    return textOf(element);
  };

  if (mode === 'table') {
    const tables = elements;
    const rows = tables.flatMap((table) =>
      Array.from(table.querySelectorAll('tr')).map((row) =>
        Array.from(row.querySelectorAll('th,td')).map((cell) => textOf(cell)),
      ),
    );
    return { ok: true, data: rows, count: rows.length, message: `已提取 ${rows.length} 行表格数据` };
  }

  if (multiple) {
    const values = elements.map(valueOf);
    return { ok: true, data: values, count: values.length, message: `已提取 ${values.length} 个元素` };
  }

  return { ok: true, data: valueOf(elements[0]!), count: 1, message: '已提取 1 个元素' };
}
