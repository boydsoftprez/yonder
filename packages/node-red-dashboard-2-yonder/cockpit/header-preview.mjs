// SPDX-License-Identifier: GPL-3.0-or-later
// Real Dashboard shell with synthetic telemetry; all aircraft writes refused.
// Build the cockpit widget and yonder-core first; run from any directory.
import {createRequire} from 'node:module';
import Module from 'node:module';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,cpSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixture} from './fixture.mjs';
import {packInstruments} from '../../yonder-core/dist/cockpit/instrumentation-wire.js';
import {randomUUID} from 'node:crypto';
import {packFlight} from '../../yonder-core/dist/cockpit/flight-wire.js';
import {themeCss} from '../../yonder-core/dist/console/theme.js';
const root=fileURLToPath(new URL('../../../',import.meta.url)),vendor=join(root,'vendor/console/node_modules');
process.env.NODE_PATH=vendor;Module._initPaths();
const require=createRequire(join(vendor,'node-red/package.json')),RED=require('node-red'),express=require('express');
const userDir=mkdtempSync(join(tmpdir(),'yonder-header-preview-')),modules=join(userDir,'node_modules');mkdirSync(join(modules,'@flowfuse'),{recursive:true});
cpSync(join(vendor,'@flowfuse/node-red-dashboard'),join(modules,'@flowfuse/node-red-dashboard'),{recursive:true});
symlinkSync(join(root,'packages/node-red-dashboard-2-yonder'),join(modules,'node-red-dashboard-2-yonder'),'dir');
writeFileSync(join(userDir,'package.json'),JSON.stringify({name:'yonder-header-preview',dependencies:{'@flowfuse/node-red-dashboard':'1.31.0','node-red-dashboard-2-yonder':'0.1.0'}}));
const index=join(modules,'@flowfuse/node-red-dashboard/dist/index.html');writeFileSync(index,readFileSync(index,'utf8').replace('</head>','<link rel="stylesheet" href="/fixture-theme.css"></head>'));
const ids=['yonder-console','dashboard','palette','page-flight','group-cockpit','cockpit-display','page-status'];
const flows=JSON.parse(readFileSync(join(root,'flows/flows.json'),'utf8')).filter(n=>ids.includes(n.id));writeFileSync(join(userDir,'flows.json'),JSON.stringify(flows));
const app=express(),server=createServer(app);let snapshot;
app.get('/fixture-theme.css',(_req,res)=>res.type('text/css').send(themeCss('night')));
app.get('/cockpit/api/flight',(_req,res)=>{snapshot=fixture();res.json(packFlight(snapshot,'fixture'))});
app.get('/cockpit/api/details',(_req,res)=>{snapshot??=fixture();res.json({detailKey:'fixture',identity:snapshot.identity,capabilities:snapshot.capabilities,operations:[],dataOptions:{imagery:false,terrain:false,traffic:false}})});
app.get('/cockpit/api/mission',(_req,res)=>{snapshot??=fixture();res.json({generation:snapshot.identity.generation,mission:snapshot.mission})});
app.get('/cockpit/api/instruments',(_req,res)=>res.json(packInstruments(fixture().instruments)));
app.use('/cockpit/api',(_req,res)=>res.status(403).json({error:'Read-only synthetic UI preview; no aircraft transport'}));
RED.init(server,{userDir,httpAdminRoot:'/editor',httpNodeRoot:'/',flowFile:'flows.json',credentialSecret:randomUUID(),httpAdminMiddleware:(req,res,next)=>req.method==='GET'&&req.url.startsWith('/resources/')?next():res.sendStatus(403),logging:{console:{level:'warn'}}});app.use('/editor',RED.httpAdmin);app.use(RED.httpNode);
await new Promise(resolve=>server.listen(4228,'127.0.0.1',resolve));await RED.start();
console.log('Synthetic cockpit in the real Dashboard shell: http://127.0.0.1:4228/dashboard/flight');
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await RED.stop();server.close();rmSync(userDir,{recursive:true,force:true});process.exit(0)});
