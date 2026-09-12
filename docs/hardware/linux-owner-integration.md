# Linux owner integration evidence

Status: native account projection has been exercised in disposable ARM64 Linux.
It is not yet installed or exposed in a board image. Requirements: R-SYS-10,
R-SEC-02/10/14 and R-STO-03.

The owner service uses the shared durable coordinator for account creation,
password changes and SSH policy. Its public result contains only the username,
enabled authentication methods and public-key fingerprints. Console credentials
remain separate. Native tools receive passwords and shadow hashes on stdin;
failed command output is discarded. Input validation rejects service account
names, account database syntax, unsupported keys, private keys and arbitrary
authorized-key options.

The Linux projector uses `useradd`, `chpasswd`, `usermod`, `userdel`, `getent`,
`visudo`, `sshd` and `ssh-keygen`. It tags accounts it creates and refuses to adopt
an unrelated account. Rollback removes only the managed account and an empty
failed-setup home; it does not recursively delete owner files or replace the
system account databases. Owner records are authoritative; the normal protected
boot's RAM view of `/etc` must be recreated from them before dependent services.

Native password creation uses Trixie's `mkpasswd --method=yescrypt --stdin`
from the `whois` package. The observed default is the `j9T` parameter set with
a 22-character salt and 43-character hash. Supported restored records are this
yescrypt format and bounded SHA-512 crypt records. This is Linux's shadow format,
not Yonder's application password format. See the Debian
[mkpasswd manual](https://manpages.debian.org/trixie/whois/mkpasswd.1.en.html) and
[crypt format reference](https://manpages.debian.org/trixie/libcrypt-dev/crypt.5.en.html).

## Executed checks

After building core and preparing the ARM64 Node payload:

```sh
npx vitest run --root packages/yonder-core src/owner-access src/admin/sensitive-process.test.ts
./scripts/verify-owner-linux.sh
```

The Linux script creates an isolated container, installs actual distro tools,
copies the compiled test inputs into the container and prints their aggregate
hash. Its fixture runs against the container's own account database. The service
lifecycle callback is recorded because that container does not run systemd;
SSH authentication itself is tested with a real localhost `sshd` listener.

The 11 September 2026 run passed:

- Reserved and existing-account refusal, with the service account unchanged.
- An injected failure after native account creation, full rollback and a retry.
- An injected password-projection failure, restoration of the old shadow hash,
  and actual sudo authentication using the old password.
- Password-required sudo; noninteractive passwordless sudo was refused.
- SSH password login when selected; direct root SSH login was refused.
- SSH public-key login with password authentication disabled; the password login
  then failed.
- Empty transaction status after the completed operations.

The final recorded compiled-tree hash for that run was
`ee9634b96dc2170ce5aa6511c64103d859bfd6f79ef430b60a1af790013bd70c`.
An earlier run left a busy transaction after an injected failure; subsequent
isolated runs passed. Its cause is not established, so the isolated passes do not
close that investigation or qualify electrical power loss.

Root-helper RPC integration, service sandbox permissions, local tty onboarding,
authenticated Settings, protected-mode board login, maintenance and power-cut
qualification remain pending. The native projector has not changed the developer
host's accounts or the connected board.

The terminal harness can be checked independently after building core:

```sh
python3 scripts/verify-owner-terminal.py
```

It passed hidden password and confirmation entry and Ctrl-C cancellation through
a real pseudo-terminal. Setup tests cover a configured owner, mismatched
passwords, cancellation and a lost create response without replaying the mutation.
These are host integration checks; the physical tty1 onboarding check remains
pending. Password-hashing failure before staging also leaves the shared guard
free in the real coordinator regression. The native projection fault fixture now
targets only its intended forward state, so it cannot accidentally inject the
same fault into a rollback. This does not establish the cause of the earlier
intermittent failure.
