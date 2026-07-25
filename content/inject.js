/**
 * 可选内容脚本：页面内状态浮层（当前版本以 executeScript 注入为主，
 * 此文件预留扩展，manifest 未默认注册，避免对所有站点常驻注入）。
 */

(() => {
  if (window.__autoCheckinInjected) return;
  window.__autoCheckinInjected = true;
})();
