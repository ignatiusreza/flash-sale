import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Fail rather than drift to 5174: the documented address would then serve
    // nothing, or an older dev server, while this one runs somewhere else.
    strictPort: true,
    // Bind all interfaces, not just loopback: inside a devcontainer a server
    // listening only on localhost is unreachable from the host that published
    // its port, which looks like the dev server silently not working.
    host: true,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/socket.io': { target: 'http://localhost:3000', ws: true, changeOrigin: true },
    },
  },
});
