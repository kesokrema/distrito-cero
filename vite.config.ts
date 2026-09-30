import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        rigPreview: 'rig-preview.html'
      },
      output: {
        manualChunks: { three: ['three'] }
      }
    }
  }
});
