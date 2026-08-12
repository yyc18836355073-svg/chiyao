import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';

// Capacitor App 环境跳过 SW 注册（原生壳内不需要）
const isNativeApp = () => !!(window.Capacitor && window.Capacitor.isNativePlatform());

if ('serviceWorker' in navigator && !isNativeApp()) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/chiyao/sw.js').catch((err) => {
      console.error('[PWA] Service Worker 注册失败:', err);
    });
  });
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
