// SPDX-License-Identifier: GPL-2.0
#include <assert.h>
#include <stdio.h>

#include "imx462_hdr2.h"

int main(void)
{
	struct imx462_hdr2_timing timing;
	unsigned int vmax;

	/* The vendor table defaults: SHS1=2, SHS2=0x6c9, RHS1=0xe1. */
	assert(imx462_hdr2_calculate(2440, 702, 222, 0, 0, &timing) == 0);
	assert(timing.shs1 == 2);
	assert(timing.shs2 == 0x6c9);

	assert(imx462_hdr2_calculate(2440, 1, 1, 98, 98, &timing) == 0);
	assert(timing.shs1 == 223);
	assert(timing.shs2 == 2438);
	assert(imx462_hdr2_calculate(2440, 2212, 222, 0, 0, &timing) == 0);
	assert(timing.shs2 == IMX462_HDR2_RHS1 + 2);
	assert(imx462_hdr2_calculate(2400, 2212, 222, 0, 0, &timing) < 0);

	/* Previously these could underflow and then be silently clamped. */
	assert(imx462_hdr2_calculate(2440, 0, 1, 0, 0, &timing) < 0);
	assert(imx462_hdr2_calculate(2440, 1, 0, 0, 0, &timing) < 0);
	assert(imx462_hdr2_calculate(2440, 2213, 1, 0, 0, &timing) < 0);
	assert(imx462_hdr2_calculate(2440, 1, 223, 0, 0, &timing) < 0);
	assert(imx462_hdr2_calculate(2440, 1, 1, 99, 0, &timing) < 0);
	assert(imx462_hdr2_calculate(2440, 1, 1, 0, 99, &timing) < 0);

	assert(imx462_hdr2_fsc_to_vmax(2440, &vmax) == 0);
	assert(vmax == 1220);
	assert(imx462_hdr2_fsc_to_vmax(2441, &vmax) == 0);
	assert(vmax == 1221);
	assert(imx462_hdr2_calculate(vmax * 2, 702, 222, 0, 0,
				     &timing) == 0);
	assert(timing.shs2 == 1739);
	assert(imx462_hdr2_fsc_to_vmax(IMX462_HDR2_VMAX_MAX * 2 + 2,
					  &vmax) < 0);

	puts("imx462 HDR2 arithmetic tests passed");
	return 0;
}
