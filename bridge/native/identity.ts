import { randomBytes } from "node:crypto";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const MASK_48 = 0xffffffffffffn;

function randomBase62(length: number): string {
  const bytes = randomBytes(length);
  let output = "";
  for (let i = 0; i < length; i++) output += BASE62[bytes[i] % BASE62.length];
  return output;
}

/** OpenCode session shape: ses_ + inverted 48-bit clock + 14 base62 chars. */
export function mintSessionID(now = Date.now()): string {
  const ordered = BigInt(now) & MASK_48;
  const inverted = (~ordered) & MASK_48;
  return `ses_${inverted.toString(16).padStart(12, "0")}${randomBase62(14)}`;
}

/** OpenCode project shape: 40 lowercase hex characters. */
export function mintProjectID(): string {
  return randomBytes(20).toString("hex");
}
