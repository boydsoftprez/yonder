// SPDX-License-Identifier: GPL-3.0-or-later
import { createApp } from 'vue';
import App from './App.vue';
import './harness.css';
const app=createApp(App);
// R-FLT-29: `YonderPicture` (mounted for the first time inside this harness
// once a camera fills the flight display, K-68) calls `$dataTracker` as a
// function (`this.$dataTracker(this.id)`), the same contract every other
// injecting component in src/ui/ already uses — `{}` answered every other
// widget in this harness because none of them had ever called it, and threw
// the moment one did, taking Vue's own render scheduler down with it.
app.provide('$socket',{emit(){throw new Error('Fixture cannot emit Dashboard commands')}});app.provide('$dataTracker',()=>{});app.mount('#app');
