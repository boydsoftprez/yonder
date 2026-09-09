// SPDX-License-Identifier: GPL-3.0-or-later
// R-UI-09: design-only entry. No live-mode option or aircraft transport.
import {createApp} from 'vue';
import InstrumentStudy from './instruments/InstrumentStudy.vue';
import './harness.css';
const app=createApp(InstrumentStudy);
app.provide('$socket',{emit(){throw Error('Instrument study has no aircraft transport')}});
app.provide('$dataTracker',{});
app.mount('#app');
