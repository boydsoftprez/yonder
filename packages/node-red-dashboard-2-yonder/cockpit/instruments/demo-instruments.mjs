// SPDX-License-Identifier: GPL-3.0-or-later
// R-UI-09: fixture limits for a visual study, never aircraft configuration.
const G='#00cf52',Y='#ffff00',R='#ff3333';
export const instruments={
 power:{label:'CURRENT',name:'Current / power',unit:'A',min:0,max:30,ticks:[0,10,20,30],precision:1,style:'arc',bands:[[0,22,G],[22,27,Y],[27,30,R]],value:8.4,secondary:'131 W',source:'Battery 1 · propulsion'},
 battery:{label:'BATTERY 1',name:'Battery remaining',unit:'%',min:0,max:100,ticks:[0,25,50,75,100],style:'vertical',bands:[[0,15,R],[15,30,Y],[30,100,G]],value:78,secondary:'15.6 V',source:'Battery 1 · propulsion'},
 used:{label:'CHARGE USED',name:'Consumed mAh / Wh',unit:'mAh',min:0,max:8000,ticks:[0,4000,8000],style:'horizontal',bands:[[0,5600,G],[5600,6800,Y],[6800,8000,R]],value:1760,secondary:'27.5 Wh USED',source:'Battery 1 · demo capacity 8,000 mAh'},
 lte:{label:'AIRCRAFT LTE',name:'LTE signal / quality',unit:'dBm',min:-125,max:-75,ticks:[-125,-100,-75],style:'horizontal',bands:[[-125,-115,R],[-115,-105,Y],[-105,-75,G]],value:-94,secondary:'RSRP · SINR 16 dB',source:'Aircraft modem 1 · example signal bands'},
 cpu:{label:'YONDER CPU',name:'Companion CPU / temperature',unit:'%',min:0,max:100,ticks:[0,25,50,75,100],style:'arc',bands:[[0,75,G],[75,90,Y],[90,100,R]],value:38,secondary:'56 °C',source:'Yonder companion · utilisation, not load average'},
 link:{label:'FLIGHT LINK',name:'Link delay / telemetry age',unit:'ms',min:0,max:1000,ticks:[0,500,1000],style:'horizontal',bands:[[0,300,G],[300,700,Y],[700,1000,R]],value:180,secondary:'TELEMETRY 0.2 s OLD',source:'Aircraft to browser · round-trip delay'},
 throttle:{label:'THROTTLE',name:'Throttle output',unit:'%',min:0,max:100,ticks:[0,50,100],style:'arc',bands:[[0,100,G]],value:58,secondary:'AUTOPILOT OUTPUT',source:'Flight controller · output, not measured RPM'},
 volts:{label:'BUS VOLTS',name:'Battery bus voltage',unit:'V',min:12,max:17,ticks:[12,14.5,17],precision:1,style:'horizontal',bands:[[12,13.2,R],[13.2,14.2,Y],[14.2,17,G]],value:15.6,secondary:'BATTERY 1',source:'Demo four-cell pack · limits require aircraft setup'},
 temp:{label:'BOARD TEMP',name:'Board temperature',unit:'°C',min:20,max:100,ticks:[20,60,100],style:'vertical',bands:[[20,75,G],[75,85,Y],[85,100,R]],value:56,secondary:'YONDER COMPANION',source:'Companion temperature sensor · example thermal bands'}
};
export const defaultSlots=()=>['power','battery','used','lte','cpu','link'].map(id=>({id,style:''}));
