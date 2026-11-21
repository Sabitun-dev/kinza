import { createRoot } from 'react-dom/client';
import './index.css';
import { initTelegram } from './tg';
import { App } from './App';

initTelegram();
createRoot(document.getElementById('root')!).render(<App />);
