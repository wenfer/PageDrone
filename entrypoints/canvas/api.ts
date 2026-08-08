import type {
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
  STOP: 'STOP',
  RUN_SITE: 'RUN_SITE',
  PROCEDURE_LIST: 'PROCEDURE_LIST',
  RUN_PROCEDURE: 'RUN_PROCEDURE',
  RUN_PROCEDURE_ABORT: 'RUN_PROCEDURE_ABORT',
  FLOW_LIST: 'FLOW_LIST',
  FLOW_SAVE: 'FLOW_SAVE',
  FLOW_DELETE: 'FLOW_DELETE',
  FLOW_TEST_RESULT: 'FLOW_TEST_RESULT',
  FLOW_TEST_PROGRESS: 'FLOW_TEST_PROGRESS',
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
  runProcedure: (procedureId: string, url: string, diagnostic = false, executionId?: string) =>
    sendMessage<RunResponse>(MSG.RUN_PROCEDURE, {
      procedureId,
      url,
      keepTab: !diagnostic,
      active: !diagnostic,
      diagnostic,
      // 技能归属于网站，正式运行和诊断都要复用该网站的登录技能；
      // 这样登录失效会统一回写站点的“需要登录”状态。
      withSiteLogin: true,
      executionId,
    }),
  abortProcedure: (executionId: string) => sendMessage<{ ok?: boolean }>(MSG.RUN_PROCEDURE_ABORT, { executionId }),
  stop: () => sendMessage<{ ok?: boolean }>(MSG.STOP, { reason: '流程用户强制停止' }),
  runSite: (siteId: string, force: boolean) =>
    sendMessage<RunResponse>(MSG.RUN_SITE, { siteId, force }),
  httpRequest: (url: string, method: string, headers: string | Record<string, string>, body: string, timeoutMs: number) =>
    sendMessage<HttpRequestResponse>(MSG.HTTP_REQUEST, { url, method, headers, body, timeoutMs }),
};
