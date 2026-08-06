/**
 * LLM 客户端：统一 Anthropic / OpenAI 的端点、鉴权请求头与响应解包。
 *
 * 由 AI 探索引擎（explorer.ts）与设置页的「测试连通性 / 获取模型列表」共用，
 * 保证三处走的是同一套 baseUrl 拼接与请求头合并规则——设置页测通了，探索就能跑通。
 */

import type { LlmProvider } from './models.js';

export interface LlmConfig {
  provider: LlmProvider;
  apiKey: string;
  /** 留空使用官方 endpoint */
  baseUrl?: string;
  model?: string;
  /** 用户自定义请求头，原始多行文本（每行 `Key: Value`） */
  headers?: string;
}

export const DEFAULT_BASE_URL: Record<LlmProvider, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
};

export const DEFAULT_MODEL: Record<LlmProvider, string> = {
  anthropic: 'claude-3-5-sonnet-20241022',
  openai: 'gpt-4o-mini',
};

/** 官方 endpoint 所需的最小请求头集合（设置页据此渲染「默认值」预览） */
export function defaultLlmHeaders(provider: LlmProvider, apiKey: string): Record<string, string> {
  if (provider === 'openai') {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };
  }
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    // 扩展页发起的直连请求，Anthropic 要求显式声明
    'anthropic-dangerous-direct-browser-access': 'true',
  };
}

/** 把 `Key: Value` 多行文本解析成对象；忽略空行与 `#` 注释行 */
export function parseHeaderText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf(':');
    if (i <= 0) continue;
    const name = s.slice(0, i).trim();
    if (!name) continue;
    out[name] = s.slice(i + 1).trim();
  }
  return out;
}

export function formatHeaders(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}

/** 预览用途：只留头尾，避免设置页把完整 key 明晃晃打在界面上 */
export function maskKey(key: string): string {
  const k = String(key || '');
  if (!k) return '(未填写 API Key)';
  if (k.length <= 12) return `${k.slice(0, 2)}****`;
  return `${k.slice(0, 7)}****${k.slice(-4)}`;
}

/**
 * 合并默认头与用户自定义头：
 * - 同名（大小写不敏感）覆盖默认值
 * - 值留空表示删掉这个默认头
 * - 值里的 `{{apiKey}}` 会被替换成实际 API Key
 */
export function resolveHeaders(
  provider: LlmProvider,
  apiKey: string,
  customText?: string
): Record<string, string> {
  const merged = defaultLlmHeaders(provider, apiKey);
  const custom = parseHeaderText(customText || '');
  for (const [name, rawValue] of Object.entries(custom)) {
    const existing = Object.keys(merged).find((k) => k.toLowerCase() === name.toLowerCase());
    if (existing) delete merged[existing];
    if (rawValue !== '') {
      merged[name] = rawValue.replace(/\{\{\s*apiKey\s*\}\}/g, apiKey);
    }
  }
  return merged;
}

export interface ChatOptions {
  system?: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
}

export interface TestResult {
  ok: boolean;
  model: string;
  reply: string;
  latencyMs: number;
  message: string;
}

export class LlmClient {
  readonly provider: LlmProvider;
  readonly apiKey: string;
  readonly model: string;
  private readonly base: string;
  private readonly headerText: string;

  constructor(config: LlmConfig) {
    this.provider = config.provider === 'openai' ? 'openai' : 'anthropic';
    this.apiKey = (config.apiKey || '').trim();
    this.model = (config.model || '').trim() || DEFAULT_MODEL[this.provider];
    this.base = ((config.baseUrl || '').trim() || DEFAULT_BASE_URL[this.provider]).replace(/\/+$/, '');
    this.headerText = config.headers || '';
  }

  get headers(): Record<string, string> {
    return resolveHeaders(this.provider, this.apiKey, this.headerText);
  }

  private requireKey(): void {
    if (!this.apiKey) throw new Error('未配置大模型 API Key，请到「全局设置 → AI 设置」填写');
  }

  /** 拉取可用模型 id 列表；两家的 /v1/models 都返回 { data: [{ id }] } */
  async listModels(): Promise<string[]> {
    this.requireKey();
    const resp = await fetch(`${this.base}/v1/models`, { method: 'GET', headers: this.headers });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      throw new Error(`获取模型列表失败 ${resp.status}：${t.slice(0, 200)}`);
    }
    const data = (await resp.json()) as { data?: { id?: string }[]; models?: { id?: string }[] };
    // 兼容部分代理网关把字段命名为 models
    const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
    const ids = list.map((m) => String(m?.id || '')).filter(Boolean);
    return [...new Set(ids)].sort();
  }

  /** 发一条最小消息验证连通性与鉴权 */
  async test(prompt?: string): Promise<TestResult> {
    this.requireKey();
    const startedAt = Date.now();
    const reply = await this.chat({
      user: (prompt || '').trim() || '请只回复两个字：可用',
      maxTokens: 64,
      temperature: 0,
    });
    const latencyMs = Date.now() - startedAt;
    const trimmed = reply.trim();
    return {
      ok: true,
      model: this.model,
      reply: trimmed,
      latencyMs,
      message: trimmed
        ? `连通正常（${this.model}，${latencyMs}ms）：${trimmed.slice(0, 60)}`
        : `连通正常（${this.model}，${latencyMs}ms），但模型未返回文本`,
    };
  }

  async chat(options: ChatOptions): Promise<string> {
    this.requireKey();
    return this.provider === 'openai' ? this.chatOpenAI(options) : this.chatAnthropic(options);
  }

  private async chatOpenAI(options: ChatOptions): Promise<string> {
    const messages: { role: string; content: string }[] = [];
    if (options.system) messages.push({ role: 'system', content: options.system });
    messages.push({ role: 'user', content: options.user });

    const resp = await fetch(`${this.base}/v1/chat/completions`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        model: this.model,
        max_tokens: options.maxTokens ?? 512,
        temperature: options.temperature ?? 0,
        messages,
      }),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      throw new Error(`OpenAI API ${resp.status}：${t.slice(0, 200)}`);
    }
    const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
    return data?.choices?.[0]?.message?.content || '';
  }

  private async chatAnthropic(options: ChatOptions): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: options.maxTokens ?? 512,
      temperature: options.temperature ?? 0,
      messages: [{ role: 'user', content: options.user }],
    };
    if (options.system) body.system = options.system;

    const resp = await fetch(`${this.base}/v1/messages`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      throw new Error(`Anthropic API ${resp.status}：${t.slice(0, 200)}`);
    }
    const data = (await resp.json()) as { content?: { type: string; text?: string }[] };
    if (Array.isArray(data?.content)) {
      const textBlock = data.content.find((b) => b.type === 'text');
      return textBlock?.text || '';
    }
    return '';
  }
}
