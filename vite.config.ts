import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';

// Quest Browser needs a secure context for WebXR:
//  - USB: `adb reverse tcp:5173 tcp:5173` then open http://localhost:5173 on the headset, or
//  - Wi-Fi: `npm run dev:https` and open https://<your-lan-ip>:5173 (accept the self-signed cert).
export default defineConfig({
  plugins: process.env.HTTPS ? [basicSsl()] : [],
  server: {
    host: true,
    port: 5173,
    proxy: { '/api': 'http://localhost:8787' },
  },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
});
