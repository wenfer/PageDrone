/**
 * 扩展内部消息类型。
 * 约定：常量值等于常量名，所以 switch 里只需 `case MSG.X:`，不要再并一个 `case 'X':`。
 */

export const MSG = {
  RUN_ALL: 'RUN_ALL',
  RUN_SITE: 'RUN_SITE',
  GET_STATUS: 'GET_STATUS',
  RESCHEDULE: 'RESCHEDULE',
  STOP: 'STOP',
  PING: 'PING',
  // Procedures
  PROCEDURE_LIST: 'PROCEDURE_LIST',
  PROCEDURE_SAVE: 'PROCEDURE_SAVE',
  PROCEDURE_DELETE: 'PROCEDURE_DELETE',
  RUN_PROCEDURE: 'RUN_PROCEDURE',
  RUN_PROCEDURE_ABORT: 'RUN_PROCEDURE_ABORT',
  // Market
  MARKET_INDEX: 'MARKET_INDEX',
  MARKET_INSTALL: 'MARKET_INSTALL',
  // Flows (canvas)
  FLOW_LIST: 'FLOW_LIST',
  FLOW_SAVE: 'FLOW_SAVE',
  FLOW_DELETE: 'FLOW_DELETE',
  // —— AI 流程诊断：画布执行完成后回传报告 ——
  FLOW_TEST_RESULT: 'FLOW_TEST_RESULT',
  FLOW_TEST_PROGRESS: 'FLOW_TEST_PROGRESS',
  // —— 流程接口请求 ——
  HTTP_REQUEST: 'HTTP_REQUEST',
  // —— AI 探索生成（归纳期）——
  EXPLORE_GENERATE: 'EXPLORE_GENERATE',
  EXPLORE_ABORT: 'EXPLORE_ABORT',
  // —— AI 设置：连通性测试与模型列表 ——
  LLM_TEST: 'LLM_TEST',
  LLM_MODELS: 'LLM_MODELS',
  // —— AI 对话 ——
  AGENT_CHAT_SEND: 'AGENT_CHAT_SEND',
  AGENT_CHAT_ABORT: 'AGENT_CHAT_ABORT',
  AGENT_CHAT_RESET: 'AGENT_CHAT_RESET',
  AGENT_CHAT_HISTORY: 'AGENT_CHAT_HISTORY',
  AGENT_CHAT_CREATE: 'AGENT_CHAT_CREATE',
  AGENT_CHAT_DELETE: 'AGENT_CHAT_DELETE',
  // —— 执行时偏差介入（自愈期）——
  INTERVENTION_RESOLVE: 'INTERVENTION_RESOLVE',
  // —— 录制生成技能（人工示范期）——
  RECORD_START: 'RECORD_START',
  RECORD_STOP: 'RECORD_STOP',
  // 注入页面的采集器发出，采集器无法引用模块作用域，那边写的是字面量
  RECORD_EVENT: 'RECORD_EVENT',
  RECORD_STEP_REMOVE: 'RECORD_STEP_REMOVE',
  RECORD_DISCARD: 'RECORD_DISCARD',
} as const;

export type MessageType = (typeof MSG)[keyof typeof MSG];

export const RUN_STATE = {
  IDLE: 'idle',
  RUNNING: 'running',
  WAITING_CF: 'waiting_cf',
  NEED_MANUAL: 'need_manual',
  EXPLORING: 'exploring',
  NEED_INTERVENTION: 'need_intervention',
  RECORDING: 'recording',
} as const;

export type RunState = (typeof RUN_STATE)[keyof typeof RUN_STATE];
