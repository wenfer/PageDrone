import ReactDOM from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import '@/assets/globals.css';
import App from './App';
import './style.css';

const colorScheme = window.matchMedia('(prefers-color-scheme: dark)');
const syncColorScheme = () => document.documentElement.classList.toggle('dark', colorScheme.matches);
syncColorScheme();
colorScheme.addEventListener('change', syncColorScheme);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ReactFlowProvider>
    <App />
  </ReactFlowProvider>,
);
