import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import 'leaflet/dist/leaflet.css';
// Fonts ship with the app (no font CDN at runtime): Bricolage Grotesque for display, Mukta for
// everything else (Latin + Devanagari, loaded per script via unicode-range).
import '@fontsource-variable/bricolage-grotesque/opsz.css';
import '@fontsource/mukta/400.css';
import '@fontsource/mukta/500.css';
import '@fontsource/mukta/600.css';
import '@fontsource/mukta/700.css';
import './styles.css';
import { applyTheme } from './ds/theme.js';
import App from './App.jsx';
import { SessionProvider } from './session.jsx';
import { registerServiceWorker } from './pwa.js';

registerServiceWorker();
applyTheme();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <App />
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>,
);
