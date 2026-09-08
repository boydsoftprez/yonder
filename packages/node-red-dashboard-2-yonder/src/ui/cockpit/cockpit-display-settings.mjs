// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-25: local presentation choices, never autopilot settings.
export const cockpitDisplayDefaults=Object.freeze({arrangement:'single',bankPlacement:'side',showDataBar:true,homePointer:true,distanceUnit:'nm'});
export function cockpitDisplaySettings(input={}){
 const result={...cockpitDisplayDefaults};
 if(['single','split','stacked'].includes(input?.arrangement))result.arrangement=input.arrangement;
 if(['side','top','mfd','hidden'].includes(input?.bankPlacement))result.bankPlacement=input.bankPlacement;
 if(['nm','mi','km'].includes(input?.distanceUnit))result.distanceUnit=input.distanceUnit;
 for(const key of ['showDataBar','homePointer'])if(typeof input?.[key]==='boolean')result[key]=input[key];
 return result;
}
