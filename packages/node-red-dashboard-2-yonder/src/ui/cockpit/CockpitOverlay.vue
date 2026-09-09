<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
 <span ref="anchor" hidden></span>
 <Teleport :to="target" :disabled="!attached">
  <div ref="host" class="y-cockpit cockpit-overlay-host" :data-palette="palette()" data-cockpit-overlay @keydown.esc.stop.prevent="emit('escape')"><slot/></div>
 </Teleport>
</template>
<script setup>
import {inject,ref,onMounted,onBeforeUnmount,nextTick} from 'vue';
const emit=defineEmits(['escape']);
const palette=inject('cockpitPalette',()=> 'night');
const anchor=ref(null),host=ref(null),attached=ref(false),target=ref('body');
async function move(){
 const focused=document.activeElement;
 target.value=document.fullscreenElement||'body';attached.value=anchor.value?.isConnected===true;
 await nextTick();if(focused?.isConnected&&host.value?.contains(focused))focused.focus();
}
function bodyEscape(e){if(e.key==='Escape'&&!e.defaultPrevented&&document.activeElement===document.body&&[...document.querySelectorAll('[data-cockpit-overlay]')].at(-1)===host.value){e.preventDefault();emit('escape')}}
onMounted(()=>{move();document.addEventListener('fullscreenchange',move);document.addEventListener('keydown',bodyEscape)});
onBeforeUnmount(()=>{document.removeEventListener('fullscreenchange',move);document.removeEventListener('keydown',bodyEscape)});
</script>
<style>
.y-cockpit.cockpit-overlay-host{position:fixed;inset:0;height:auto;width:auto;display:block;padding:0;border:0;container-type:normal;container-name:none;isolation:isolate;z-index:12000;pointer-events:none;background:none}
.cockpit-overlay-host>*{pointer-events:auto}
</style>
