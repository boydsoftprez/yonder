<template><YonderCockpit ref="cockpit" v-if="live" id="service-cockpit"/><YonderCockpit ref="cockpit" v-else id="fixture-cockpit" :report="report" :api="api"/></template>
<script setup>
import {ref,onBeforeUnmount,onMounted} from 'vue';
import YonderCockpit from '../src/ui/YonderCockpit.vue';
import {fixture,fixtureLeg} from './fixture.mjs';
const cockpit=ref(null);
const live=new URLSearchParams(location.search).get('live')==='1',report=ref(fixture()),calls=[];
const api={command:async body=>{calls.push(body);return {accepted:true,operationId:'fixture-request-'+calls.length}},dataOptions:async options=>({dataOptions:options})};
const timer=setInterval(()=>{report.value={...report.value,sequence:report.value.sequence+1}},500);onBeforeUnmount(()=>clearInterval(timer));
onMounted(()=>{if(live)return;const relay=new URLSearchParams(location.search).get('ground');if(!relay)return;try{const u=new URL(relay);if(['127.0.0.1','localhost'].includes(u.hostname)&&u.protocol==='http:'){const host=cockpit.value;host.groundRelayUrl=u.origin;host.groundRelayInput=u.origin;host.aircraftDatum='EGM96';host.onlineTerrain=true;host.configureGroundData()}}catch{}});
window.cockpitFixture={calls,set(value){report.value=value},leg(seq,error=20){report.value=fixtureLeg(report.value,seq,error)},snapshot(){return report.value},reset(){report.value=fixture();calls.length=0}};
</script>
