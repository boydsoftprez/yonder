// SPDX-License-Identifier: GPL-3.0-or-later
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

/**
 * One widget per build, because UMD has one entry.
 *
 * Dashboard 2.x loads a third-party widget by the `output` file named in this
 * package's `node-red-dashboard-2` manifest, and a UMD bundle exposes exactly
 * one global — so a bundle per widget is the format's requirement rather than
 * a choice. `scripts/build-widgets.mjs` reads the manifest and drives this
 * config once per entry, which keeps the manifest the single list.
 *
 * `vue` and `vuex` are external: Dashboard already has both on the page. A
 * second copy of Vue inside our bundle would be a second reactivity system
 * that our components' injected `$socket` and `$dataTracker` do not belong
 * to, and a second Vuex would be a second store — so the components would
 * read an empty one and draw nothing, on a page where everything else worked.
 *
 * `yonder-core` is deliberately **not** external. It is bundled, because the
 * page has no module loader to resolve it and because `reading()` has to be
 * the same implementation the node package tests — one rule for what a value
 * means, not two (ADR-0009).
 */

/**
 * Fold each widget's CSS into its own bundle.
 *
 * Vite emits a Vue SFC's `<style scoped>` as a separate `style.css`. With one
 * build per widget and a shared `outDir`, every build overwrote the last, so
 * a full build left exactly one widget's styles on disk and the other four
 * rendering as unstyled markup — a failure that appears only in a browser, and
 * only for the widgets that are not last in the manifest.
 *
 * Dashboard loads the `output` file named in the manifest and nothing beside
 * it, so the fix is for that file to carry its own styles. The tag is keyed by
 * widget type and injected once, because a widget can be on a page more than
 * once and the bundle can be evaluated more than that.
 */
function inlineStyles (type) {
    return {
        name: 'yonder-inline-styles',
        // After Vite's own css-post plugin, which is what creates the asset
        // this one folds away.
        enforce: 'post',
        generateBundle: {
            order: 'post',
            handler (_options, bundle) {
            let css = ''
            for (const [file, asset] of Object.entries(bundle)) {
                if (asset.type === 'asset' && file.endsWith('.css')) {
                    css += String(asset.source)
                    delete bundle[file]
                }
            }
            if (!css) return
            for (const asset of Object.values(bundle)) {
                if (asset.type !== 'chunk' || !asset.isEntry) continue
                const id = JSON.stringify('yonder-style-' + type)
                asset.code =
                    '(function(){try{if(typeof document==="undefined")return;' +
                    'if(document.getElementById(' + id + '))return;' +
                    'var s=document.createElement("style");s.id=' + id + ';' +
                    's.textContent=' + JSON.stringify(css) + ';' +
                    'document.head.appendChild(s)}catch(e){}})();\n' + asset.code
                }
            }
        }
    }
}

export default defineConfig(({ mode }) => {
  const name = process.env.WIDGET;
  if (!name) throw new Error("vite.config.js: set WIDGET to the component name");
  return {
    plugins: [vue(), inlineStyles(process.env.WIDGET_TYPE)],
    define: { "process.env.NODE_ENV": JSON.stringify(mode) },
    build: {
      emptyOutDir: false,
      outDir: "dist",
      lib: {
        entry: fileURLToPath(new URL(`./src/ui/${name}.vue`, import.meta.url)),
        name,
        formats: ["umd"],
        fileName: () => `${process.env.WIDGET_TYPE}.umd.js`,
      },
      rollupOptions: {
        external: ["vue", "vuex"],
        output: { globals: { vue: "Vue", vuex: "Vuex" } },
      },
    },
  };
});
