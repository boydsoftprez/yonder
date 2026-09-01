// SPDX-License-Identifier: GPL-3.0-or-later
import type { ZodError } from "zod";

export class ConfigError extends Error {
  readonly issues: string[];
  constructor(message: string, issues: string[] = []) {
    super(issues.length ? `${message}\n  ${issues.join("\n  ")}` : message);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

export function formatIssues(err: ZodError): string[] {
  return err.issues.map((i) => {
    const path = i.path.join(".") || "(root)";
    return `${path}: ${i.message}`;
  });
}
