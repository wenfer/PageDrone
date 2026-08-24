/**
 * 在 Service Worker 中发起用户/调用方显式配置的 HTTP 请求。
 * 由 MSG.HTTP_REQUEST（画布「发送请求」节点）与 MCP `http-request` 工具共享。
 */

export async function performHttpRequest(options: {
  url: string;
  method?: string;
  headers?: Record<string, string> | string;
  body?: unknown;
  timeoutMs?: number;
}): Promise<Record<string, unknown>> {
  const url = String(options.url || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('请求 URL 必须是 http(s) 地址');
  const method = String(options.method || 'GET').toUpperCase();
  const allowed = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
  if (!allowed.has(method)) throw new Error(`不支持的请求方法：${method}`);

  const timeoutMs = Math.min(120000, Math.max(1000, Number(options.timeoutMs) || 30000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {};
    let rawHeaders: Record<string, string> = {};
    if (typeof options.headers === 'string' && options.headers.trim()) {
      try {
        const parsed = JSON.parse(options.headers);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          rawHeaders = Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value ?? '')]));
        }
      } catch {
        for (const line of options.headers.split(/\r?\n/)) {
          const index = line.indexOf(':');
          if (index > 0) rawHeaders[line.slice(0, index).trim()] = line.slice(index + 1).trim();
        }
      }
    } else if (options.headers && typeof options.headers === 'object') {
      rawHeaders = options.headers;
    }
    for (const [key, value] of Object.entries(rawHeaders)) {
      const name = String(key || '').trim();
      if (!name) continue;
      headers[name] = String(value ?? '');
    }

    let body: BodyInit | undefined;
    if (method !== 'GET' && method !== 'HEAD' && options.body !== undefined && options.body !== null) {
      if (typeof options.body === 'string') {
        body = options.body;
      } else {
        body = JSON.stringify(options.body);
        if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
          headers['Content-Type'] = 'application/json';
        }
      }
    }

    const response = await fetch(url, {
      method,
      headers,
      body,
      credentials: 'omit',
      redirect: 'follow',
      signal: controller.signal,
    });
    const raw = await response.text();
    const contentType = response.headers.get('content-type') || '';
    let data: unknown = raw;
    if (/json/i.test(contentType) && raw.trim()) {
      try { data = JSON.parse(raw); } catch { /* keep raw response */ }
    }
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => { responseHeaders[key] = value; });
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      data,
      url: response.url || url,
      message: response.ok ? `请求成功（${response.status}）` : `请求失败（HTTP ${response.status}）`,
    };
  } catch (error) {
    if ((error as DOMException)?.name === 'AbortError') {
      throw new Error(`请求超时（${timeoutMs}ms）`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
