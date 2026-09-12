// SPDX-License-Identifier: GPL-3.0-or-later
import type { PublicOwnerState } from "./service.js";
import { validateOwnerPassword, validateOwnerUsername } from "./model.js";

export interface OwnerSetupClient {
  ownerState(): Promise<PublicOwnerState>;
  ownerCreate(input: { username: string; newPassword: string; confirmPassword: string }): Promise<PublicOwnerState>;
}
export interface OwnerSetupTerminal {
  write(message: string): void;
  read(prompt: string, hidden?: boolean): Promise<string>;
}

/** The terminal and browser use the same atomic first-owner operation. */
export async function runOwnerSetup(client: OwnerSetupClient, terminal: OwnerSetupTerminal): Promise<void> {
  if ((await client.ownerState()).configured) return;
  terminal.write("Yonder Linux account setup\nThis password is for local login and sudo. Set the console password separately over Wi-Fi.\n");
  for (;;) {
    const username = await terminal.read("Linux username (blank to continue to login): ");
    if (!username) return;
    try { validateOwnerUsername(username); }
    catch { terminal.write("Choose a lowercase account name using letters, digits, underscores or hyphens.\n"); continue; }
    let password = await terminal.read("Linux password: ", true);
    let confirmation = await terminal.read("Confirm password: ", true);
    try {
      try { validateOwnerPassword(password); }
      catch { terminal.write("Use at least 8 characters without control characters.\n"); continue; }
      if (password !== confirmation) { terminal.write("Passwords do not match. Try again.\n"); continue; }
      await client.ownerCreate({ username, newPassword: password, confirmPassword: confirmation });
      terminal.write("Linux account created. Log in below; sudo requires your password. SSH starts off and can be enabled in Yonder Settings.\n");
      return;
    } catch {
      // A lost response can follow a committed create. Never resubmit a secret
      // operation automatically or print errors that might quote native inputs.
      if ((await client.ownerState()).configured) {
        terminal.write("A Linux owner is configured. Continue to login.\n");
        return;
      }
      terminal.write("Account setup did not complete. Check Yonder diagnostics, or try another account name.\n");
    } finally { password = ""; confirmation = ""; }
  }
}
