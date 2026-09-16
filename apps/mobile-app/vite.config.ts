import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// A different port from the admin shell (5173) so both can run at once. The
// API's CORS allowlist is explicit, so add this origin to CORS_ORIGINS when
// running locally — see .env.example.
export default defineConfig({
  plugins: [react()],
  server: { port: 5174 },
});
