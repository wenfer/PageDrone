import React from 'react';
import ReactDOM from 'react-dom/client';
import '@/assets/globals.css';
import App from './App';
import './styles.css';

function OptionsRoot() {
  React.useEffect(() => {
    const preference = window.matchMedia('(prefers-color-scheme: dark)');
    const syncTheme = () => document.documentElement.classList.toggle('dark', preference.matches);
    syncTheme();
    preference.addEventListener('change', syncTheme);
    return () => preference.removeEventListener('change', syncTheme);
  }, []);
  return <App />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <OptionsRoot />
  </React.StrictMode>,
);
