import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Authored as .mjs rather than .ts because a build script outside the package's
// `rootDir` belongs to no TypeScript project, and the repo lints with
// `projectService`, which requires every linted .ts file to be in one.
export default defineConfig({
  plugins: [react(), tailwindcss()],

  // The webview is loaded from a file URI the extension computes with
  // `asWebviewUri`, so every asset reference must be relative to index.html.
  base: './',

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Content hashes would force the extension to parse index.html to find the
    // bundle. Stable names let it build the URI directly, and cache-busting is
    // irrelevant for assets served from the extension's own directory.
    rollupOptions: {
      output: {
        entryFileNames: 'assets/main.js',
        chunkFileNames: 'assets/[name].js',
        // Rollup names the extracted stylesheet after the HTML entry ("index"),
        // not after `entryFileNames`, so the CSS is renamed explicitly. Everything
        // else keeps its own name so future fonts and images do not collide.
        assetFileNames: (asset) =>
          asset.name !== undefined && asset.name.endsWith('.css')
            ? 'assets/main.css'
            : 'assets/[name][extname]',
      },
    },
    // The webview host provides no source-map UI worth the bundle size.
    sourcemap: false,
    target: 'es2022',
  },
});
