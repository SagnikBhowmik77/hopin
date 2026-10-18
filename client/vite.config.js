import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const api = process.env.HOPIN_API || 'http://localhost:8720';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5190,
    strictPort: true,
    proxy: {
      '/api': api,
      '/socket.io': { target: api, ws: true },
    },
    // When launched through an 8.3 short path on Windows (C:/Users/SAGNIK~1/...),
    // Vite 403s its own index.html because the real path never matches the allow
    // list. Safe here: the dev server only binds to loopback and builds ignore it.
    fs: { strict: false },
  },
});
