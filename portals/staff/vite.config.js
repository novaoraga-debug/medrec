import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// The shared/ folder lives outside this portal, so bare imports inside shared/
// must be aliased to this portal's own node_modules.
const modules = (name) => fileURLToPath(new URL(`./node_modules/${name}`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      react: modules('react'),
      'react-dom': modules('react-dom'),
      'framer-motion': modules('framer-motion')
    }
  },
  server: {
    port: 5184,
    fs: { allow: ['..'] }
  }
});