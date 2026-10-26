// @ts-check
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://geromolina.com',
  // The dev toolbar covers the phone level chip.
  devToolbar: { enabled: false },
  // One small stylesheet per page: inline it so nothing blocks the first paint.
  build: { inlineStylesheets: 'always' },
});
