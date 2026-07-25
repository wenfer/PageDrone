/** 扩展内部消息类型 */

export const MSG = {
  RUN_ALL: 'RUN_ALL',
  RUN_SITE: 'RUN_SITE',
  GET_STATUS: 'GET_STATUS',
  STATUS_UPDATE: 'STATUS_UPDATE',
  RESCHEDULE: 'RESCHEDULE',
  STOP: 'STOP',
  PING: 'PING',
};

export const RUN_STATE = {
  IDLE: 'idle',
  RUNNING: 'running',
  WAITING_CF: 'waiting_cf',
  NEED_MANUAL: 'need_manual',
};
