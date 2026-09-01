// SPDX-License-Identifier: GPL-3.0-or-later
import { randomInt } from "node:crypto";

/**
 * Alphabet excludes O, 0, l, I and 1 — a per-device access-point password
 * gets read off a screen and typed on a phone, often in a field.
 */
const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const LENGTHS = { psk: 16, password: 16, token: 32 } as const;

export function generateSecret(kind: keyof typeof LENGTHS): string {
  const n = LENGTHS[kind];
  let out = "";
  for (let i = 0; i < n; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}
