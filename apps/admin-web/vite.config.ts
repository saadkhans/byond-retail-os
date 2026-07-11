import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Local dev runs on the port the API's default CORS allowlist expects.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
});
