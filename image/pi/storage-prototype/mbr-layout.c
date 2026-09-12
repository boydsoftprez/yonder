// SPDX-License-Identifier: GPL-3.0-or-later
#define _FILE_OFFSET_BITS 64
#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <linux/fs.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <unistd.h>

enum {
    sector_size = 512,
    table_offset = 446,
    entry_size = 16,
};

static const uint64_t base_bytes = UINT64_C(2977955840);
static const uint64_t image_bytes = UINT64_C(8589934592);
static const uint32_t disk_id = UINT32_C(0x041bba91);
static const uint32_t boot_start = 16384, boot_count = 1048576;
static const uint32_t root_start = 1064960, root_count = 12582912;
static const uint32_t state_start = 13647872, state_count = 1048576;
static const uint32_t extended_start = 14696448, extended_count = 2080768;
static const uint32_t log_start = 14698496, log_count = 524288;
static const uint32_t second_ebr = 15222784;
static const uint32_t media_start = 15224832, media_count = 1552384;

static void fail(const char *format, ...)
{
    va_list args;
    va_start(args, format);
    fputs("yonder-pi-mbr-layout: ", stderr);
    vfprintf(stderr, format, args);
    fputc('\n', stderr);
    va_end(args);
    exit(1);
}

static uint32_t get_le32(const unsigned char *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
        ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static void put_le32(unsigned char *p, uint32_t value)
{
    p[0] = (unsigned char)value;
    p[1] = (unsigned char)(value >> 8);
    p[2] = (unsigned char)(value >> 16);
    p[3] = (unsigned char)(value >> 24);
}

static void read_exact(int fd, void *buffer, size_t length, off_t offset)
{
    unsigned char *p = buffer;
    while (length > 0) {
        ssize_t got = pread(fd, p, length, offset);
        if (got <= 0)
            fail("read failed at offset %jd: %s", (intmax_t)offset,
                got == 0 ? "unexpected end of file" : strerror(errno));
        p += got;
        length -= (size_t)got;
        offset += got;
    }
}

static void write_exact(int fd, const void *buffer, size_t length, off_t offset)
{
    const unsigned char *p = buffer;
    while (length > 0) {
        ssize_t wrote = pwrite(fd, p, length, offset);
        if (wrote <= 0)
            fail("write failed at offset %jd: %s", (intmax_t)offset,
                wrote == 0 ? "zero-length write" : strerror(errno));
        p += wrote;
        length -= (size_t)wrote;
        offset += wrote;
    }
}

static unsigned char *entry(unsigned char sector[sector_size], unsigned int index)
{
    return sector + table_offset + index * entry_size;
}

static bool entry_empty(const unsigned char *p)
{
    for (unsigned int i = 0; i < entry_size; ++i)
        if (p[i] != 0)
            return false;
    return true;
}

static void require_signature(const unsigned char sector[sector_size], const char *name)
{
    if (sector[510] != 0x55 || sector[511] != 0xaa)
        fail("%s has no DOS signature", name);
}

static void require_entry(const unsigned char *p, unsigned char type,
    uint32_t start, uint32_t count, const char *name)
{
    if ((p[0] != 0 && p[0] != 0x80) || p[4] != type ||
        get_le32(p + 8) != start || get_le32(p + 12) != count)
        fail("%s geometry or type differs from the prototype", name);
}

static void set_entry(unsigned char *p, unsigned char type,
    uint32_t start, uint32_t count)
{
    memset(p, 0, entry_size);
    p[4] = type;
    put_le32(p + 8, start);
    put_le32(p + 12, count);
}

static void require_unused_entries(unsigned char sector[sector_size],
    unsigned int first, const char *name)
{
    for (unsigned int i = first; i < 4; ++i)
        if (!entry_empty(entry(sector, i)))
            fail("%s contains an unexpected partition entry", name);
}

static uint64_t device_bytes(int fd, const struct stat *status)
{
    if (S_ISREG(status->st_mode))
        return (uint64_t)status->st_size;
    if (S_ISBLK(status->st_mode)) {
        uint64_t bytes = 0;
        int logical = 0;
        if (ioctl(fd, BLKGETSIZE64, &bytes) != 0)
            fail("cannot read block-device size: %s", strerror(errno));
        if (ioctl(fd, BLKSSZGET, &logical) != 0 || logical != sector_size)
            fail("block device does not use 512-byte logical sectors");
        return bytes;
    }
    fail("target is neither a regular image nor a block device");
    return 0;
}

static void read_tables(int fd, unsigned char mbr[sector_size],
    unsigned char ebr1[sector_size], unsigned char ebr2[sector_size])
{
    read_exact(fd, mbr, sector_size, 0);
    read_exact(fd, ebr1, sector_size, (off_t)extended_start * sector_size);
    read_exact(fd, ebr2, sector_size, (off_t)second_ebr * sector_size);
}

static void validate_fixed(unsigned char mbr[sector_size],
    unsigned char ebr1[sector_size], unsigned char ebr2[sector_size],
    uint32_t wanted_extended, uint32_t wanted_link, uint32_t wanted_media)
{
    require_signature(mbr, "MBR");
    require_signature(ebr1, "first EBR");
    require_signature(ebr2, "second EBR");
    if (get_le32(mbr + 440) != disk_id)
        fail("DOS disk identifier differs from the prototype");
    require_entry(entry(mbr, 0), 0x0c, boot_start, boot_count, "boot partition");
    require_entry(entry(mbr, 1), 0x83, root_start, root_count, "root partition");
    require_entry(entry(mbr, 2), 0x83, state_start, state_count, "state partition");
    require_entry(entry(mbr, 3), 0x0f, extended_start, wanted_extended,
        "extended partition");
    require_entry(entry(ebr1, 0), 0x83, log_start - extended_start,
        log_count, "journal logical partition");
    require_entry(entry(ebr1, 1), 0x0f, second_ebr - extended_start,
        wanted_link, "second EBR link");
    require_unused_entries(ebr1, 2, "first EBR");
    require_entry(entry(ebr2, 0), 0x83, media_start - second_ebr,
        wanted_media, "media logical partition");
    require_unused_entries(ebr2, 1, "second EBR");
}

static void assemble(int fd, const struct stat *status)
{
    unsigned char mbr[sector_size], ebr1[sector_size] = {0}, ebr2[sector_size] = {0};
    if (!S_ISREG(status->st_mode) || (uint64_t)status->st_size != base_bytes)
        fail("assembly requires the exact-length regular base image");
    read_exact(fd, mbr, sector_size, 0);
    require_signature(mbr, "base MBR");
    if (get_le32(mbr + 440) != disk_id)
        fail("base DOS disk identifier differs from the locked input");
    require_entry(entry(mbr, 0), 0x0c, boot_start, boot_count, "base boot partition");
    require_entry(entry(mbr, 1), 0x83, root_start, 4751360, "base root partition");
    if (!entry_empty(entry(mbr, 2)) || !entry_empty(entry(mbr, 3)))
        fail("base image contains an unexpected partition");
    if ((uint64_t)(root_start + UINT32_C(4751360)) * sector_size != base_bytes)
        fail("locked root partition does not end at the image boundary");

    if (ftruncate(fd, (off_t)image_bytes) != 0)
        fail("cannot extend image: %s", strerror(errno));
    put_le32(entry(mbr, 1) + 12, root_count);
    set_entry(entry(mbr, 2), 0x83, state_start, state_count);
    set_entry(entry(mbr, 3), 0x0f, extended_start, extended_count);

    set_entry(entry(ebr1, 0), 0x83, log_start - extended_start, log_count);
    set_entry(entry(ebr1, 1), 0x0f, second_ebr - extended_start,
        (uint32_t)(image_bytes / sector_size - second_ebr));
    ebr1[510] = 0x55;
    ebr1[511] = 0xaa;
    set_entry(entry(ebr2, 0), 0x83, media_start - second_ebr, media_count);
    ebr2[510] = 0x55;
    ebr2[511] = 0xaa;

    write_exact(fd, entry(mbr, 1) + 12, 4, table_offset + entry_size + 12);
    write_exact(fd, entry(mbr, 2), entry_size, table_offset + 2 * entry_size);
    write_exact(fd, entry(mbr, 3), entry_size, table_offset + 3 * entry_size);
    write_exact(fd, ebr1, sector_size, (off_t)extended_start * sector_size);
    write_exact(fd, ebr2, sector_size, (off_t)second_ebr * sector_size);
    if (fsync(fd) != 0)
        fail("cannot flush assembled layout: %s", strerror(errno));
    read_tables(fd, mbr, ebr1, ebr2);
    validate_fixed(mbr, ebr1, ebr2, extended_count,
        (uint32_t)(image_bytes / sector_size - second_ebr), media_count);
}

#ifdef YONDER_TESTING
static void stop_after(const char *stage)
{
    const char *requested = getenv("YONDER_GROW_STOP_AFTER");
    if (requested != NULL && strcmp(requested, stage) == 0) {
        fprintf(stderr, "test interruption after %s count\n", stage);
        exit(75);
    }
}
#else
static void stop_after(const char *stage)
{
    (void)stage;
}
#endif

static void write_count(int fd, off_t offset, uint32_t value, const char *stage)
{
    unsigned char encoded[4], check[4];
    put_le32(encoded, value);
    write_exact(fd, encoded, sizeof(encoded), offset);
    if (fsync(fd) != 0)
        fail("cannot flush %s count: %s", stage, strerror(errno));
    read_exact(fd, check, sizeof(check), offset);
    if (get_le32(check) != value)
        fail("%s count did not verify after flush", stage);
    stop_after(stage);
}

static void grow(int fd, const struct stat *status)
{
    if (!S_ISBLK(status->st_mode))
        fail("growth target must be a block device");
    uint64_t bytes = device_bytes(fd, status);
    if (bytes % sector_size != 0 || bytes < image_bytes)
        fail("device is smaller than the prototype image or not sector-aligned");
    uint64_t sectors64 = bytes / sector_size;
    uint64_t ext64 = sectors64 - extended_start;
    uint64_t link64 = sectors64 - second_ebr;
    uint64_t media64 = sectors64 - media_start;
    if (ext64 > UINT32_MAX || link64 > UINT32_MAX || media64 > UINT32_MAX)
        fail("device exceeds DOS partition-count capacity");
    uint32_t target_extended = (uint32_t)ext64;
    uint32_t target_link = (uint32_t)link64;
    uint32_t target_media = (uint32_t)media64;

    unsigned char mbr[sector_size], ebr1[sector_size], ebr2[sector_size];
    read_tables(fd, mbr, ebr1, ebr2);
    uint32_t have_extended = get_le32(entry(mbr, 3) + 12);
    uint32_t have_link = get_le32(entry(ebr1, 1) + 12);
    uint32_t have_media = get_le32(entry(ebr2, 0) + 12);

    bool state0 = have_extended == extended_count &&
        have_link == image_bytes / sector_size - second_ebr &&
        have_media == media_count;
    bool state1 = have_extended == target_extended &&
        have_link == image_bytes / sector_size - second_ebr &&
        have_media == media_count;
    bool state2 = have_extended == target_extended &&
        have_link == target_link && have_media == media_count;
    bool state3 = have_extended == target_extended &&
        have_link == target_link && have_media == target_media;
    if (!(state0 || state1 || state2 || state3))
        fail("partition counts are not a valid growth prefix");

    validate_fixed(mbr, ebr1, ebr2, have_extended, have_link, have_media);
    if (have_extended != target_extended)
        write_count(fd, table_offset + 3 * entry_size + 12,
            target_extended, "container");
    if (have_link != target_link)
        write_count(fd, (off_t)extended_start * sector_size +
            table_offset + entry_size + 12, target_link, "link");
    if (have_media != target_media)
        write_count(fd, (off_t)second_ebr * sector_size +
            table_offset + 12, target_media, "media");

    read_tables(fd, mbr, ebr1, ebr2);
    validate_fixed(mbr, ebr1, ebr2, target_extended, target_link, target_media);
    printf("%" PRIu32 "\n", target_media);
}

int main(int argc, char **argv)
{
    if (argc != 3 || (strcmp(argv[1], "assemble") != 0 &&
            strcmp(argv[1], "grow") != 0)) {
        fputs("Usage: yonder-pi-mbr-layout assemble IMAGE | grow BLOCK_DEVICE\n", stderr);
        return 2;
    }
    int flags = O_RDWR | O_CLOEXEC;
    if (strcmp(argv[1], "assemble") == 0)
        flags |= O_NOFOLLOW;
    int fd = open(argv[2], flags);
    if (fd < 0)
        fail("cannot open target: %s", strerror(errno));
    struct stat status;
    if (fstat(fd, &status) != 0)
        fail("cannot inspect target: %s", strerror(errno));
    (void)device_bytes(fd, &status);
    if (strcmp(argv[1], "assemble") == 0)
        assemble(fd, &status);
    else
        grow(fd, &status);
    if (close(fd) != 0)
        fail("cannot close target: %s", strerror(errno));
    return 0;
}
