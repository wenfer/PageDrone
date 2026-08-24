import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

const icons = {
  16: 'icons/icon16.png',
  48: 'icons/icon48.png',
  128: 'icons/icon128.png',
};

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  manifestVersion: 3,
  manifest: {
    name: 'PageDrone',
    description: '浏览器自动化工具 - 画布编排任务与流程，支持条件/循环/并行与通用浏览器自动化。',
    permissions: [
      'storage',
      'alarms',
      'scripting',
      'tabs',
      'cookies',
      'notifications',
      'unlimitedStorage',
    ],
    host_permissions: ['<all_urls>'],
    action: {
      default_title: '自动执行助手',
      default_icon: icons,
    },
    options_ui: {
      page: 'options.html',
      open_in_tab: true,
    },
    icons,
  },
});
