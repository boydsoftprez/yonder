# Recovered storage and boot evidence

Reviewed 10 September 2026. This supplements the [current discovery report](image-storage-discovery.md).
Historical observations are evidence for the tested revisions, not automatic qualification
of a future release image. No historical private images or credentials are copied here.

| Prior work | Evidence recovered | Reuse and limit |
|---|---|---|
| Pi offline installation, 1 September | `docs/hardware/verifying-m1a.md`, “What has actually run on hardware” | Offline installation ran; initial service path failed. Later AP, rollback and fallback worked on the patched card. Retain these cases; do not describe them all as untested. |
| Radxa filesystem repair, 6 September | Session “Diagnose Radxa SD card boot”, `repair-completed.md` | 52 blocks repaired; complete 30,937,186,304-byte partition read back against checked repaired image. Repair verified; protection policy unchanged. |
| Radxa post-repair boot, 6 September | Same session, `live-boot-check.txt` and `live-boot-followup.txt` | SSH over ZeroTier, core/console/media/mesh active, sign-in page responding. Existing-image boot and recovery demonstrated. |
| Offline root shrink, 6 September | `shrink-test-result.json` and `shrink-test.txt` | Separate repaired-image copy shrunk to 8,589,934,592 bytes; pre-check, resize and five-pass post-check all exit 0. Physical card not resized. Reuse feasibility evidence; recheck sizing against selected release base. |
| Storage architecture, 6 September | `codex/storage-hardening` worktree, `2026-09-06-power-loss-storage-design.md` | Prior detailed design covers boot protection, state separation, identity, logging and maintenance. It is a proposal, not deployed mount/partition code. |
| Reduced command tracing | Same worktree, uncommitted changes in core `log.ts` and `log.test.ts` | Existing implementation candidate with tests, not present in audited main. Preserve and review against execution baseline rather than rewrite it. No test rerun performed in this historical review. |
| Pi reboot startup, 7 September | Session “Fix Yonder reboot startup” | Reported software-reboot recovery, RTSP and MAVLink over ZeroTier after hotfix; full power-cycle result explicitly pending. Reuse existing-install reboot evidence, with revision scope. |

## Reconciliation with current decisions

The September 6 proposal included A/B OS slots and custom Node-RED state preservation.
The present session explicitly excluded those; do not restore them from older notes.
The prior 8 GiB shrink is not approval to reserve two 8 GiB slots in new images.

The earlier session explicitly requested diagnostic logs surviving reboot. Following this
review, the user confirmed bounded persistent logs and a 10-second synchronization interval.
The current spec and both plan copies now reflect that decision; volatile-log wording is
superseded. Settings and credentials remain immediately durable, independently of log
batching. Production journal capacity and measured write volume remain discovery work.

## Effect on the next step

Do not repeat baseline board bring-up, recovery repair or shrink experiments merely
because they were absent from the first discovery report. Continue image/prototype
preparation using this evidence. A disposable card is needed for the *changed* boot and
storage layout's hardware acceptance, not to establish again that these boards can run
Yonder. No recovered record establishes protected-layout boot plus real power-cut
qualification, and current live mounts remain writable.
