import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ command, mode }) => ({
  plugins: [tailwindcss()],
  base: mode === 'production' ? '/punchcard-digitizer/' : '/',
}));
