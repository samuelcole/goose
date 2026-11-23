import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    ssr: true,
    outDir: '.vite/build',
    rollupOptions: {
      input: 'src/webPanePreload.ts',
      output: {
        format: 'cjs',
        entryFileNames: 'webPanePreload.js',
      },
      external: ['electron'],
    },
  },
});
