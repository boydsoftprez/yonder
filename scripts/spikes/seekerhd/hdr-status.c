// SPDX-License-Identifier: GPL-3.0-or-later
/* R-CTL-06: read-only bench evidence for the Zero 3 / I2C2 SeekerHD.
 * Build using this board's matching vendor UAPI headers. No images are read.
 */
#include <errno.h>
#include <fcntl.h>
#include <linux/i2c-dev.h>
#include <linux/i2c.h>
#include <linux/rk-camera-module.h>
#include <linux/v4l2-subdev.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

static unsigned int read_reg(int fd, unsigned int reg, unsigned short count)
{
    unsigned char address[] = { reg >> 8, reg & 255 }, data[3] = {};
    struct i2c_msg msgs[] = {
        { .addr = 0x1a, .len = 2, .buf = address },
        { .addr = 0x1a, .flags = I2C_M_RD, .len = count, .buf = data }
    };
    struct i2c_rdwr_ioctl_data transfer = { .msgs = msgs, .nmsgs = 2 };
    if (ioctl(fd, I2C_RDWR, &transfer) != 2) { perror("sensor register read"); exit(1); }
    return data[0] | data[1] << 8 | data[2] << 16;
}

int main(int argc, char **argv)
{
    if (argc != 2) { fprintf(stderr, "Usage: hdr-status /dev/v4l-subdevN\n"); return 2; }
    int fd = open(argv[1], O_RDONLY | O_CLOEXEC);
    if (fd < 0) { perror("sensor open"); return 1; }
    struct rkmodule_inf info = {};
    if (ioctl(fd, RKMODULE_GET_MODULE_INFO, &info) < 0 || strcmp(info.base.sensor, "imx462")) {
        fprintf(stderr, "Expected the SeekerHD IMX462 sensor\n"); return 1;
    }
    struct rkmodule_hdr_cfg hdr = {};
    int queried = ioctl(fd, RKMODULE_GET_HDR_CFG, &hdr) == 0;
    struct v4l2_subdev_frame_interval interval = {};
    if (ioctl(fd, VIDIOC_SUBDEV_G_FRAME_INTERVAL, &interval) < 0) { perror("frame interval"); return 1; }
    close(fd);
    fd = open("/dev/i2c-2", O_RDWR | O_CLOEXEC);
    if (fd < 0) { perror("I2C2 open"); return 1; }
    unsigned int wdmode = read_reg(fd, 0x300c, 1);
    unsigned int vmax = read_reg(fd, 0x3018, 3), hmax = read_reg(fd, 0x301c, 2);
    unsigned int shs1 = read_reg(fd, 0x3020, 3), shs2 = read_reg(fd, 0x3024, 3);
    unsigned int rhs1 = read_reg(fd, 0x3030, 3);
    unsigned int long_gain = read_reg(fd, 0x3014, 1), short_gain = read_reg(fd, 0x30f2, 1);
    unsigned int lanes = read_reg(fd, 0x3443, 1) + 1, repetition = read_reg(fd, 0x3405, 1);
    close(fd);
    printf("{\"hdr_query\":%s,\"hdr_mode\":%u,\"packing\":%u,\"hdr_abi_size\":%zu,"
           "\"interval\":[%u,%u],\"wdmode\":%u,\"vmax\":%u,\"hmax\":%u,"
           "\"shs1\":%u,\"shs2\":%u,\"rhs1\":%u,\"long_gain\":%u,\"short_gain\":%u,"
           "\"lanes\":%u,\"repetition\":%u}\n", queried ? "true" : "false", hdr.hdr_mode,
           hdr.esp.mode, sizeof(hdr), interval.interval.numerator, interval.interval.denominator,
           wdmode, vmax, hmax, shs1, shs2, rhs1, long_gain, short_gain, lanes, repetition);
    return 0;
}
