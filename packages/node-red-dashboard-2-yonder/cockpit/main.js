// SPDX-License-Identifier: GPL-3.0-or-later
import { createApp } from 'vue';
import App from './App.vue';
import './harness.css';
const app=createApp(App);
app.provide('$socket',{emit(){throw new Error('Fixture cannot emit Dashboard commands')}});app.provide('$dataTracker',{});app.mount('#app');
