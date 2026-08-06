/**
 * 注入页面执行用户自定义脚本。
 * 用 new Function 包装用户代码，与 Promise.race 超时赛跑。
 * 自包含：不引用模块作用域（new Function 本身在页面 world 内构造）。
 */

export interface UserScriptResult {
  ok: boolean;
  message: string;
  needKeywordCheck: boolean;
  /** 用户脚本显式 return 的数据，供有返回值技能暴露。 */
  data?: unknown;
}

export function pageRunUserScript(source: string, timeoutMs: number): Promise<UserScriptResult> {
  return (async () => {
    const timeout = Number(timeoutMs) || 60000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const runner = async () => {
        // 包装用户代码，支持 return / async
        const fn = new Function(`'use strict'; return (async () => { ${source}\n })();`);
        return await fn();
      };
      const result = await Promise.race([
        runner(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('脚本执行超时')), timeout);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (result && typeof result === 'object' && 'ok' in result) {
        const r = result as { ok: unknown; message?: string };
        return {
          ok: !!r.ok,
          message: r.message || (r.ok ? '脚本返回成功' : '脚本返回失败'),
          needKeywordCheck: false,
          ...('data' in r ? { data: (r as { data?: unknown }).data } : {}),
        };
      }
      if (typeof result === 'boolean') {
        return {
          ok: result,
          message: result ? '脚本返回 true' : '脚本返回 false',
          needKeywordCheck: false,
          data: result,
        };
      }
      // 脚本没给结论 → 交给关键词判定
      return {
        ok: true,
        message: result == null ? '脚本执行完毕' : String(result),
        needKeywordCheck: true,
        ...(
          result == null
            ? {}
            : { data: result }
        ),
      };
    } catch (e) {
      if (timer) clearTimeout(timer);
      return {
        ok: false,
        message: (e as Error)?.message || String(e),
        needKeywordCheck: false,
      };
    }
  })();
}
