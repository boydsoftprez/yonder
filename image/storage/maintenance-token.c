// SPDX-License-Identifier: GPL-3.0-or-later
#define _GNU_SOURCE
#include <errno.h>
#include <dirent.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define MAX_JSON 512
#define UUID_LEN 36
#define NO_REQUEST 10
#define CORRUPT 20

static int uuid_at(const char *p) {
    for (int i = 0; i < UUID_LEN; i++) {
        int dash = i == 8 || i == 13 || i == 18 || i == 23;
        if ((dash && p[i] != '-') || (!dash && !((p[i] >= '0' && p[i] <= '9') || (p[i] >= 'a' && p[i] <= 'f')))) return 0;
    }
    return p[14] == '4' && (p[19] == '8' || p[19] == '9' || p[19] == 'a' || p[19] == 'b');
}

static int private_file(const char *path, char out[MAX_JSON + 1]) {
    int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return 0;
    struct stat st;
    if (fstat(fd, &st) != 0 || !S_ISREG(st.st_mode) || st.st_nlink != 1 || st.st_uid != 0 || st.st_gid != 0
        || (st.st_mode & 0777) != 0600 || st.st_size < 1 || st.st_size > MAX_JSON) {
        close(fd);
        return 0;
    }
    size_t total = 0;
    ssize_t got;
    while (total < MAX_JSON + 1 && (got = read(fd, out + total, MAX_JSON + 1 - total)) > 0) total += (size_t)got;
    int saved = errno;
    close(fd);
    errno = saved;
    if (got < 0 || total > MAX_JSON || total != (size_t)st.st_size) return 0;
    out[total] = '\0';
    return 1;
}

static int exact_directory(const char *path) {
    DIR *directory = opendir(path);
    if (directory == NULL) return 0;
    struct dirent *entry;
    int valid = 1;
    errno = 0;
    while ((entry = readdir(directory)) != NULL) {
        if (strcmp(entry->d_name, ".") != 0 && strcmp(entry->d_name, "..") != 0
            && strcmp(entry->d_name, "pending.json") != 0 && strcmp(entry->d_name, "consumed.json") != 0) {
            if (strcmp(entry->d_name, "pending.json.tmp") == 0) continue;
            valid = 0;
            break;
        }
    }
    if (entry == NULL && errno != 0) valid = 0;
    if (closedir(directory) != 0) valid = 0;
    return valid;
}

static int private_temporary(const char *path) {
    int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return 0;
    struct stat st;
    int valid = fstat(fd, &st) == 0 && S_ISREG(st.st_mode) && st.st_nlink == 1
        && st.st_uid == 0 && st.st_gid == 0 && (st.st_mode & 0777) == 0600
        && st.st_size >= 0 && st.st_size <= MAX_JSON;
    close(fd);
    return valid;
}

static int sync_directory(const char *path) {
    int fd = open(path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return 0;
    int valid = fsync(fd) == 0;
    close(fd);
    return valid;
}

static int take(const char **cursor, const char *literal) {
    size_t length = strlen(literal);
    if (strncmp(*cursor, literal, length) != 0) return 0;
    *cursor += length;
    return 1;
}

static int operation_id(const char *json, char id[UUID_LEN + 1], int *awaiting) {
    const char *p = json;
    if (!take(&p, "{\"schemaVersion\":1,\"id\":\"")) return 0;
    if (!uuid_at(p)) return 0;
    memcpy(id, p, UUID_LEN); id[UUID_LEN] = '\0'; p += UUID_LEN;
    if (!take(&p, "\",\"kind\":\"maintenance\",\"phase\":\"")) return 0;
    if (take(&p, "awaiting-maintenance-reboot\"")) {
        *awaiting = 1;
    } else if (take(&p, "entered-maintenance\"")) {
        *awaiting = 0;
    } else return 0;
    if (!take(&p, ",\"previousGeneration\":\"")) return 0;
    if (!uuid_at(p)) return 0;
    p += UUID_LEN;
    if (!take(&p, "\",\"maintenance\":{\"schemaVersion\":1,\"mode\":\"writable-next-boot\"},\"startedAt\":")) return 0;
    const char *digits = p;
    while (*p >= '0' && *p <= '9') p++;
    if (p == digits || (p - digits) > 16 || (*digits == '0' && p - digits > 1)) return 0;
    return strcmp(p, "}\n") == 0;
}

static int exact_token(const char *json, const char *id) {
    char wanted[MAX_JSON + 1];
    int length = snprintf(wanted, sizeof wanted,
        "{\"schemaVersion\":1,\"kind\":\"yonder-maintenance-boot\",\"operationId\":\"%s\"}\n", id);
    return length > 0 && (size_t)length < sizeof wanted && strcmp(json, wanted) == 0;
}

static int join(char *out, size_t size, const char *root, const char *suffix) {
    int length = snprintf(out, size, "%s%s", root, suffix);
    return length > 0 && (size_t)length < size;
}

int main(int argc, char **argv) {
    if (argc != 3 || strcmp(argv[1], "consume") != 0 || argv[2][0] != '/') return 2;
    char operation[4096], pending[4096], consumed[4096], temporary[4096], directory[4096];
    if (!join(operation, sizeof operation, argv[2], "/var/lib/yonder-state/transactions/operation.json")
        || !join(directory, sizeof directory, argv[2], "/var/lib/yonder-state/maintenance")
        || !join(pending, sizeof pending, argv[2], "/var/lib/yonder-state/maintenance/pending.json")
        || !join(temporary, sizeof temporary, argv[2], "/var/lib/yonder-state/maintenance/pending.json.tmp")
        || !join(consumed, sizeof consumed, argv[2], "/var/lib/yonder-state/maintenance/consumed.json")) return 2;
    struct stat state;
    if (lstat(directory, &state) != 0) return errno == ENOENT ? NO_REQUEST : CORRUPT;
    if (!S_ISDIR(state.st_mode) || state.st_uid != 0 || state.st_gid != 0 || (state.st_mode & 0777) != 0700
        || !exact_directory(directory)) return CORRUPT;
    int pending_exists = lstat(pending, &state) == 0;
    int consumed_exists = lstat(consumed, &state) == 0;
    int temporary_exists = lstat(temporary, &state) == 0;
    if (temporary_exists) {
        if (pending_exists || consumed_exists || !private_temporary(temporary)
            || unlink(temporary) != 0 || !sync_directory(directory)) return CORRUPT;
        return NO_REQUEST;
    }
    if (pending_exists && consumed_exists) return CORRUPT;
    if (!pending_exists) return consumed_exists ? NO_REQUEST : NO_REQUEST;
    char operation_json[MAX_JSON + 1], token_json[MAX_JSON + 1], id[UUID_LEN + 1];
    int awaiting = 0;
    if (!private_file(operation, operation_json) || !operation_id(operation_json, id, &awaiting) || !awaiting
        || !private_file(pending, token_json) || !exact_token(token_json, id)) return CORRUPT;
    if (rename(pending, consumed) != 0) return CORRUPT;
    if (!sync_directory(directory)) return CORRUPT;
    puts("maintenance");
    return 0;
}
