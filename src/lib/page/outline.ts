/**
 * 注入页面执行：提取页面结构宏观大纲（标题层级、表单结构、主要导航、Meta 元信息）。
 * 自包含：不引用模块作用域，供 chrome.scripting 序列化。
 */

export interface PageOutlineHeading {
  level: number;
  text: string;
}

export interface PageOutlineFormField {
  name?: string;
  type: string;
  label?: string;
  placeholder?: string;
  required?: boolean;
}

export interface PageOutlineForm {
  id?: string;
  name?: string;
  action?: string;
  method?: string;
  fields: PageOutlineFormField[];
}

export interface PageOutlineLink {
  text: string;
  href: string;
}

export interface PageOutlineMeta {
  description?: string;
  keywords?: string;
  ogTitle?: string;
  ogDescription?: string;
}

export interface PageOutlineResult {
  url: string;
  title: string;
  meta: PageOutlineMeta;
  headings: PageOutlineHeading[];
  forms: PageOutlineForm[];
  mainLinks: PageOutlineLink[];
  summaryText: string;
}

export function samplePageOutline(): PageOutlineResult {
  const headings: PageOutlineHeading[] = [];
  const headingElements = Array.from(document.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'));
  for (const h of headingElements.slice(0, 30)) {
    const text = (h.innerText || h.textContent || '').trim().replace(/\s+/g, ' ');
    if (text) {
      const level = parseInt(h.tagName.substring(1), 10) || 1;
      headings.push({ level, text: text.slice(0, 100) });
    }
  }

  const forms: PageOutlineForm[] = [];
  const formElements = Array.from(document.querySelectorAll<HTMLFormElement>('form'));
  for (const f of formElements.slice(0, 10)) {
    const inputs = Array.from(f.querySelectorAll<HTMLElement>('input, textarea, select, button'));
    const fields: PageOutlineFormField[] = [];
    for (const input of inputs.slice(0, 20)) {
      const type = (input.getAttribute('type') || input.tagName.toLowerCase()).toLowerCase();
      const isPassword = type === 'password';
      const name = input.getAttribute('name') || undefined;
      const placeholder = input.getAttribute('placeholder') || undefined;
      const label = input.getAttribute('aria-label') || undefined;
      const required = input.hasAttribute('required');
      fields.push({
        name,
        type: isPassword ? 'password' : type,
        label,
        placeholder,
        required: required || undefined,
      });
    }
    forms.push({
      id: f.id || undefined,
      name: f.getAttribute('name') || undefined,
      action: f.getAttribute('action') || undefined,
      method: (f.getAttribute('method') || 'GET').toUpperCase(),
      fields,
    });
  }

  const mainLinks: PageOutlineLink[] = [];
  const linkElements = Array.from(document.querySelectorAll<HTMLAnchorElement>('nav a, header a, main a, a[href]'));
  const seenHrefs = new Set<string>();
  for (const a of linkElements) {
    const text = (a.innerText || a.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ');
    const href = a.href || '';
    if (text && href && !href.startsWith('javascript:') && !seenHrefs.has(href)) {
      seenHrefs.add(href);
      mainLinks.push({ text: text.slice(0, 60), href: href.slice(0, 150) });
      if (mainLinks.length >= 30) break;
    }
  }

  const getMeta = (name: string): string | undefined => {
    const el = document.querySelector<HTMLMetaElement>(`meta[name="${name}" i], meta[property="${name}" i]`);
    return el?.content?.trim() || undefined;
  };

  const meta: PageOutlineMeta = {
    description: getMeta('description'),
    keywords: getMeta('keywords'),
    ogTitle: getMeta('og:title'),
    ogDescription: getMeta('og:description'),
  };

  const summaryParts: string[] = [
    `页面标题: ${document.title || '无'}`,
    `网址: ${location.href}`,
  ];
  if (meta.description) summaryParts.push(`描述: ${meta.description}`);
  if (headings.length) {
    summaryParts.push(`标题层级 (${headings.length}):\n${headings.map((h) => `  ${'#'.repeat(h.level)} ${h.text}`).join('\n')}`);
  }
  if (forms.length) {
    summaryParts.push(`表单数量: ${forms.length}`);
  }

  return {
    url: location.href,
    title: document.title || '',
    meta,
    headings,
    forms,
    mainLinks,
    summaryText: summaryParts.join('\n'),
  };
}
