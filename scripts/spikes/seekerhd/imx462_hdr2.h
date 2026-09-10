/* SPDX-License-Identifier: GPL-2.0 */
#ifndef YONDER_IMX462_HDR2_H
#define YONDER_IMX462_HDR2_H

#define IMX462_HDR2_RHS1		225U
#define IMX462_HDR2_GAIN_MAX		98U
#define IMX462_HDR2_VMAX_MAX		0x3ffffU

struct imx462_hdr2_timing {
	unsigned int shs1;
	unsigned int shs2;
};

/*
 * Sony DOL2 constraints used by the Rockchip IMX462 table:
 *
 *   short exposure = RHS1 - SHS1 - 1,  SHS1 >= 2
 *   long exposure  = FSC - SHS2 - 1,   RHS1 + 2 <= SHS2 <= FSC - 2
 *
 * Use signed intermediates so an out-of-range unsigned request cannot wrap
 * into a register value that happens to pass a later bound check.
 */
static inline int
imx462_hdr2_calculate(unsigned int fsc, unsigned int long_exp,
		      unsigned int short_exp, unsigned int long_gain,
		      unsigned int short_gain,
		      struct imx462_hdr2_timing *timing)
{
	long long shs1;
	long long shs2;

	if (!timing || long_gain > IMX462_HDR2_GAIN_MAX ||
	    short_gain > IMX462_HDR2_GAIN_MAX)
		return -1;

	shs1 = (long long)IMX462_HDR2_RHS1 - short_exp - 1;
	shs2 = (long long)fsc - long_exp - 1;
	if (!short_exp || shs1 < 2 || shs1 >= IMX462_HDR2_RHS1)
		return -1;
	if (!long_exp || shs2 < IMX462_HDR2_RHS1 + 2 ||
	    shs2 > (long long)fsc - 2)
		return -1;

	timing->shs1 = (unsigned int)shs1;
	timing->shs2 = (unsigned int)shs2;
	return 0;
}

/*
 * FSC is the two-exposure frame length; the sensor VMAX register is half.
 * Round an odd ISP request up so the programmed frame is never shorter than
 * requested (the hardware's effective FSC remains even).
 */
static inline int
imx462_hdr2_fsc_to_vmax(unsigned int fsc, unsigned int *vmax)
{
	unsigned int rounded_vmax;

	if (!vmax || fsc < 2 || fsc > IMX462_HDR2_VMAX_MAX * 2U)
		return -1;

	rounded_vmax = fsc / 2 + (fsc & 1);
	if (rounded_vmax > IMX462_HDR2_VMAX_MAX)
		return -1;

	*vmax = rounded_vmax;
	return 0;
}

#endif /* YONDER_IMX462_HDR2_H */
