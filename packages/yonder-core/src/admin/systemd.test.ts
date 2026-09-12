// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const systemd = fileURLToPath(new URL("../../../../systemd", import.meta.url));

describe("admin systemd boundary", () => {
  it("makes the socket root-only and outside the console group", () => {
    const unit = readFileSync(join(systemd, "yonder-admin.socket"), "utf8");
    expect(unit).toContain("ListenStream=/run/yonder-admin/control.sock");
    expect(unit).toContain("SocketUser=root");
    expect(unit).toContain("SocketGroup=root");
    expect(unit).toContain("SocketMode=0600");
    expect(unit).not.toContain("SocketGroup=yonder");
  });

  it("runs the helper as root with fixed account paths and a loopback-only mesh control API", () => {
    const unit = readFileSync(join(systemd, "yonder-admin.service"), "utf8");
    expect(unit).not.toMatch(/^User=/m);
    expect(unit).not.toMatch(/^Group=/m);
    expect(unit).toContain("ProtectSystem=strict");
    expect(unit).toContain("ReadWritePaths=/var/lib/yonder-state /var/lib/yonder /etc /home /run/sshd -/var/lib/zerotier-one");
    expect(unit).toContain("RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6");
    expect(unit).toContain("IPAddressDeny=any");
    expect(unit).toContain("IPAddressAllow=localhost");
    expect(unit).not.toContain("Group=yonder");
  });
  it("runs only the fixed first-owner program on tty1, with normal getty afterward", () => {
    const unit = readFileSync(join(systemd, "yonder-owner-setup.service"), "utf8");
    expect(unit).toContain("TTYPath=/dev/tty1");
    expect(unit).toContain("dist/owner-access/cli.js --first-boot");
    expect(unit).not.toMatch(/autologin|ExecStart=.*(?:bash|\/sh)(?: |$)/);
    expect(readFileSync(join(systemd, "yonder-owner-getty.conf"), "utf8")).toContain("After=yonder-owner-setup.service");
    for (const name of ["yonder-core.service", "yonder-console.service"]) {
      const other = readFileSync(join(systemd, name), "utf8");
      const paths = /^ReadWritePaths=(.*)$/m.exec(other)?.[1]?.split(/\s+/) ?? [];
      expect(paths).not.toContain("/etc"); expect(paths).not.toContain("/home");
    }
  });
});
