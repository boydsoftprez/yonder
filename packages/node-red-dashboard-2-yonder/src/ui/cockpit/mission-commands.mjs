// Plane mission metadata and authoring validation. All values use MAVLink units.
// SPDX-License-Identifier: GPL-3.0-or-later
import {CATALOG} from './data/mission-commands/catalog-data.mjs';

function freeze(value){
  if(value&&typeof value==='object'){
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

export const MISSION_COMMANDS=freeze(CATALOG.commands);
const commands=new Map(MISSION_COMMANDS.map(command=>[command.id,command]));
export const getCommand=id=>commands.get(id);
const GLOBAL_FRAMES=new Set([0,3,5,6,10,11]);
const finite=value=>typeof value==='number'&&Number.isFinite(value);

function values(item){return [...item.params,item.lat,item.lon,item.alt];}

export function createMissionItem(id,point={}){
  const command=getCommand(id);
  if(!command)throw new Error(`Unknown mission command ${id}`);
  const all=[0,0,0,0,0,0,0];
  for(const param of command.params)all[param.index-1]=param.defaultValue;
  if(command.location){
    if(point.lat!==undefined)all[4]=point.lat;
    if(point.lon!==undefined)all[5]=point.lon;
  }
  if(command.altitude&&point.alt!==undefined)all[6]=point.alt;
  // Mission Planner's legacy ROI editor exposes only coordinates; use location mode.
  if(id===201)all[0]=3;
  const frame=command.location||command.altitude?(point.frame??(id===179?0:3)):2;
  return {seq:1,command:id,frame,params:all.slice(0,4),lat:all[4],lon:all[5],alt:all[6],current:false,autocontinue:true};
}

/** Validation returns findings; it never mutates an imported item or silently fixes it.
 * Unknown commands are preserved with a warning. Known commands use the Plane
 * authoring schema; editMission deliberately validates only the item being edited.
 */
export function validateMissionItem(item){
  const errors=[],warnings=[];
  const result=()=>({valid:errors.length===0,errors,warnings});
  if(!item||typeof item!=='object'||Array.isArray(item)){
    errors.push('Mission item must be an object');return result();
  }
  if(!Number.isInteger(item.seq)||item.seq<0)errors.push('Sequence must be a non-negative integer');
  if(!Number.isInteger(item.command)||item.command<0||item.command>65535)errors.push('Command must be an integer in 0..65535');
  if(!Number.isInteger(item.frame)||item.frame<0||item.frame>255)errors.push('Frame must be an integer in 0..255');
  if(typeof item.current!=='boolean')errors.push('Current flag must be boolean');
  if(typeof item.autocontinue!=='boolean')errors.push('Autocontinue flag must be boolean');
  if(!Array.isArray(item.params)||item.params.length!==4){
    errors.push('Mission item must contain exactly four parameters');return result();
  }
  const all=values(item);
  for(let index=0;index<7;index++){
    if(all[index]!==null&&!finite(all[index]))errors.push(`Parameter ${index+1} must be finite or null`);
  }
  const command=getCommand(item.command);
  if(!command){
    warnings.push(`Unknown command ${item.command} is preserved; it is outside the pinned Plane catalog`);
    return result();
  }
  if(command.location||command.altitude){
    if(!GLOBAL_FRAMES.has(item.frame))errors.push('Position/altitude authoring requires global MSL, above-home or above-terrain frame (0/3/5/6/10/11)');
    if([10,11].includes(item.frame))warnings.push('Terrain altitude requires terrain data and firmware support');
  }else if(item.frame!==2&& !GLOBAL_FRAMES.has(item.frame)){
    warnings.push(`Frame ${item.frame} is preserved; this command has no geographic position`);
  }
  if(item.command===179&&![0,5].includes(item.frame))errors.push('Specified home altitude requires an absolute MSL frame (0 or 5)');
  for(const param of command.params){
    const value=all[param.index-1],label=`${param.label} (parameter ${param.index})`;
    if(value===null){
      if(param.required)errors.push(`${label} is required`);
      continue;
    }
    if(!finite(value))continue;
    if(param.integer&&!Number.isInteger(value))errors.push(`${label} must be an integer`);
    if(param.min!==undefined&&value<param.min)errors.push(`${label} must be at least ${param.min}`);
    if(param.max!==undefined&&value>param.max)errors.push(`${label} must be at most ${param.max}`);
    if(param.options&&!param.bitmask&&!param.options.some(option=>option.value===value))errors.push(`${label} must use a listed option`);
    if(param.bitmask&&Number.isInteger(value)&&value>=0){
      const mask=param.options.reduce((mask,option)=>mask|option.value,0);
      if((value&~mask)!==0)errors.push(`${label} contains undefined flag bits`);
    }
  }
  if(item.command===93&&all[0]===-1&&all.slice(1,4).every(value=>value===-1))errors.push('UTC delay needs at least one specified hour, minute or second');
  if(item.command===531){
    const [type,value]=all;
    if(type===0&&![ -1,0,1 ].includes(value))errors.push('Step zoom must be -1, 0 or 1');
    if(type===1&&finite(value)&&Math.abs(value)>1)errors.push('Continuous zoom rate must be -1..1');
    if(type===2&&finite(value)&&(value<0||value>100))errors.push('Percentage zoom must be 0..100');
    if(type===3&&finite(value)&&value<0)errors.push('Focal length must be non-negative millimetres');
  }
  if(item.command===532&&all[0]===1&&finite(all[1])&&Math.abs(all[1])>1)errors.push('Continuous focus rate must be -1..1');
  if(command.capability!=='Plane mission command; actual firmware acceptance and execution reported separately')warnings.push(command.capability);
  return result();
}
