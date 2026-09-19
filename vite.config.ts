import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const githubPagesBase = '/painelremodelado/';

export default defineConfig({
  base: process.env.PANEL_BASE_PATH || (process.env.GITHUB_ACTIONS ? githubPagesBase : '/'),
  plugins: [react()],
  server: { port: 5191 },
  preview: { port: 5191 },
});
