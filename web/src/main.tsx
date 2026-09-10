import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { bootstrapThemeFromStorage } from './lib/theme';
import './index.css';

// 首屏先把持久化主题贴上，避免深色用户看到一帧白屏
bootstrapThemeFromStorage();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
