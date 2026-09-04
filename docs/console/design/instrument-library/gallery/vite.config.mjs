import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  plugins: [vue()],
  resolve: {
    alias: {
      "yonder-core/presentation": fileURLToPath(new URL("../../../../packages/yonder-core/dist/console/presentation.js", import.meta.url)),
    },
  },
});
