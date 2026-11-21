import { createHash, randomBytes } from "node:crypto";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const MASK_48 = 0xffffffffffffn;
/** The session time field is a 36-bit millisecond phase (~795-day cycle). */
const PHASE_MS = 68719476736n;
/** A minted session may be dated up to this far before today's UTC midnight. */
export const SESSION_TIMESTAMP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Shape of a session minted by the official client's `Identifier.descending()`:
 * `ses_` + 12 hex + 14 base62, where the hex encodes `~(ts_ms * 0x1000 + counter)`
 * and therefore starts with nine plain hex digits and ends in `f` followed by
 * three more hex digits (the inverted low counter bits).
 */
const CANONICAL_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const DESCENDING_TIME_RE = /^[0-9a-f]{9}f[c-f][0-9a-f]$/;

export function isOfficialSessionID(value: unknown): value is string {
  return (
    typeof value === "string" &&
    CANONICAL_SESSION_RE.test(value) &&
    DESCENDING_TIME_RE.test(value.slice(4, 16))
  );
}

/** Milliseconds phase encoded in a canonical session id, or null. */
export function sessionPhaseMs(id: string): number | null {
  if (!isOfficialSessionID(id)) return null;
  return Number((MASK_48 - BigInt(`0x${id.slice(4, 16)}`)) / 4096n);
}

export function currentTimePhaseMs(now = Date.now()): number {
  return Number(BigInt(now) % PHASE_MS);
}

/** How long ago the phase inside `id` was minted, modulo the phase cycle. */
export function phaseAgeMs(phase: number, now = Date.now()): number {
  const period = Number(PHASE_MS);
  return (((currentTimePhaseMs(now) - phase) % period) + period) % period;
}

function base62Fixed(bytes: Uint8Array, width: number): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) + BigInt(byte);
  let out = "";
  for (let index = 0; index < width; index++) {
    out = BASE62[Number(value % 62n)] + out;
    value /= 62n;
  }
  return out;
}

/**
 * Render a plausible recent timestamp the way `Identifier.descending()` does:
 * a 36-bit millisecond value shifted left 12 bits, ORed with counter 1, then
 * bitwise-NOT-ed so the low 12 bits read `ffe`.
 *
 * The hash only picks the offset inside the accepted window; it never supplies
 * the date itself. A hash-derived date (1970) is rejected with 429 by the free
 * tier, which derives a risk window from it.
 */
export function descendingTimePart(now: number, hash: Uint8Array): string {
  const offset =
    ((hash[0]! * 16777216 + hash[1]! * 65536 + hash[2]! * 256 + hash[3]!) %
      SESSION_TIMESTAMP_WINDOW_MS);
  const midnight = Math.floor(now / 86400000) * 86400000;
  const encoded = ((BigInt(midnight - offset) * 4096n + 1n) & MASK_48);
  return (MASK_48 - encoded).toString(16).padStart(12, "0");
}

const processSalt = randomBytes(16);

/**
 * Re-encode any identity signal into the canonical session the free tier
 * accepts, stable for the life of the process. Official ids pass through
 * untouched (preserving prompt-cache affinity); anything else is salted so a
 * restart yields fresh ids instead of resuming whatever the previous run was
 * charged for.
 */
export function canonicalSessionID(signal: string, now = Date.now()): string {
  if (isOfficialSessionID(signal)) return signal;
  const digest = createHash("sha256")
    .update("ses\0")
    .update(processSalt)
    .update("\0")
    .update(String(signal))
    .digest();
  return `ses_${descendingTimePart(now, digest.subarray(0, 6))}${base62Fixed(digest.subarray(6, 16), 14)}`;
}

/** OpenCode project shape: 40 lowercase hex characters. */
export function mintProjectID(): string {
  return randomBytes(20).toString("hex");
}

export function stableProjectID(session: string): string {
  return createHash("sha256")
    .update(`opencode-project\0${session}`)
    .digest("hex")
    .slice(0, 40);
}

/** W3C trace context + B3 in the shape the official client's fetch sends. */
export function traceHeaders(): Record<string, string> {
  const entropy = randomBytes(32).toString("hex");
  const trace = entropy.slice(0, 32);
  const span = entropy.slice(32, 48);
  const parent = entropy.slice(48);
  return { traceparent: `00-${trace}-${span}-01`, b3: `${trace}-${span}-1-${parent}` };
}
