// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
export default defineConfig({ root: fileURLToPath(new URL('.',import.meta.url)), base:'./', plugins:[vue()], server:{host:'127.0.0.1',port:4192,strictPort:true,proxy:process.env.COCKPIT_API?{'/cockpit/api':{target:process.env.COCKPIT_API,changeOrigin:false}}:undefined}, resolve:{alias:{'yonder-core/terrain':fileURLToPath(new URL('../../yonder-core/src/terrain/index.ts',import.meta.url)),'yonder-core/presentation':fileURLToPath(new URL('../../yonder-core/src/console/presentation.ts',import.meta.url))}} });
