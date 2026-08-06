import type {
  ExtractPageDataResponse,
  FlowListResponse,
  HttpRequestResponse,
  ProcedureListResponse,
  RunResponse,
  SaveFlowResponse,
  StatusResponse,
  StoredFlow,
} from './types';

export const MSG = {
  GET_STATUS: 'GET_STATUS',
  RUN_SITE: 'RUN_SITE',
  PROCEDURE_LIST: 'PROCEDURE_LIST',
  RUN_PROCEDURE: 'RUN_PROCEDURE',
  FLOW_LIST: 'FLOW_LIST',
  FLOW_SAVE: 'FLOW_SAVE',
  FLOW_DELETE: 'FLOW_DELETE',
  EXTRACT_PAGE_DATA: 'EXTRACT_PAGE_DATA',
  HTTP_REQUEST: 'HTTP_REQUEST',
} as const;

export function sendMessage<T>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (response: T & { error?: string }) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      if (response?.error) {
        reject(new Error(response.error));
        return;
      }
      resolve(response);
    });
  });
}

export const flowApi = {
  list: () => sendMessage<FlowListResponse>(MSG.FLOW_LIST),
  save: (flow: StoredFlow) => sendMessage<SaveFlowResponse>(MSG.FLOW_SAVE, { flow }),
  remove: (id: string) => sendMessage<{ ok?: boolean }>(MSG.FLOW_DELETE, { id }),
  procedures: () => sendMessage<ProcedureListResponse>(MSG.PROCEDURE_LIST),
  status: () => sendMessage<StatusResponse>(MSG.GET_STATUS),
  runProcedure: (procedureId: string, url: string) =>
    sendMessage<RunResponse>(MSG.RUN_PROCEDURE, { procedureId, url, keepTab: true }),
  runSite: (siteId: string, force: boolean) =>
    sendMessage<RunResponse>(MSG.RUN_SITE, { siteId, force }),
  /**
   * 画布执行时优先使用 URL ?tabId=，否则选当前窗口最近的 HTTP(S) 标签页。
   * 过滤扩展自身页面，避免把脚本注入 canvas.html。
   */
  getExecutionTabId: async (): Promise<number> => {
    const requested = new URLSearchParams(location.search).get('tabId');
    if (requested && /^\d+$/.test(requested)) return Number(requested);
    const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
    const webTabs = tabs.filter((tab) => tab.id != null && /^https?:\/\//i.test(tab.url || ''));
    const active = webTabs.find((tab) => tab.active);
    const candidate = active || webTabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
    if (candidate?.id == null) throw new Error('未找到可执行的网页标签页，请先打开目标网页或在 URL 中指定 tabId');
    return candidate.id;
  },
  extractPageData: (tabId: number, selector: string, mode: string, attribute: string, multiple: boolean) =>
    sendMessage<ExtractPageDataResponse>(MSG.EXTRACT_PAGE_DATA, {
      tabId, selector, mode, attribute, multiple,
    }),
  httpRequest: (url: string, method: string, headers: string | Record<string, string>, body: string, timeoutMs: number) =>
    sendMessage<HttpRequestResponse>(MSG.HTTP_REQUEST, { url, method, headers, body, timeoutMs }),
};
