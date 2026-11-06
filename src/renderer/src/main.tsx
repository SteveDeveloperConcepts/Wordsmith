import '@fontsource-variable/inter';
import '@fontsource-variable/inter/wght-italic.css';
import '@fontsource-variable/source-serif-4';
import '@fontsource-variable/source-serif-4/wght-italic.css';
import './styles/tokens.css';
import './styles/app.css';
import './styles/editor.css';
import './styles/assistant.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { resolveTheme, useSettings } from './state/settings';

// Set the theme before the first paint to avoid a flash of the wrong one.
document.documentElement.dataset.theme = resolveTheme(useSettings.getState().theme);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
