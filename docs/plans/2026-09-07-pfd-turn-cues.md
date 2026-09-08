# PFD turn cues (R-FLT-03, R-FLT-17, R-FLT-19)

Move the measured slip/skid ball immediately above the HSI heading readout.
Add green standard-rate bank pointers to the roll scale and an independent
magenta six-second heading-change vector with half/standard-rate HSI marks.
Keep flight-director commands and local references separate.

Use the already received ATTITUDE body rates and attitude to calculate heading
rate. Never substitute body yaw rate for heading rate in a bank. Use fresh
GLOBAL_POSITION_INT velocity minus ArduPlane WIND for explicitly estimated TAS;
do not relabel VFR_HUD indicated airspeed as TAS. Expire each input independently,
hide the bank pointers below 50 KT or without valid inputs, and expose the reason
and display controls in the ball's touch panel. No new aircraft stream request.

Implement Yonder geometry from documented behavior; do not copy MSFS code/assets.
Verify decoded MAVLink, compact wire compatibility/freshness, display geometry,
settings persistence, and responsive browser rendering. Preserve the running
simulator while updating the UI; report any backend refresh requirement.
