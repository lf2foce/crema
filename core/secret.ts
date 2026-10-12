// Secrets Creama must be able to show again (hosted database passwords), sealed at rest with
// AES-256-GCM. Key: CREAMA_ENCRYPTION_KEY, else derived from BETTER_AUTH_SECRET. Rotating that
// value makes stored passwords unreadable — reset them to issue new ones.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

function key(): Buffer {
  const base = process.env.CREAMA_ENCRYPTION_KEY || process.env.BETTER_AUTH_SECRET;
  if (!base) throw new Error("Set CREAMA_ENCRYPTION_KEY (or BETTER_AUTH_SECRET) to store database passwords.");
  return Buffer.from(hkdfSync("sha256", base, "creama", "sealed-secrets/v1", 32));
}

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

export function unseal(sealed: string): string {
  const [v, iv, tag, body] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || !body) throw new Error("Unrecognised sealed secret.");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(body, "base64url")), d.final()]).toString("utf8");
}
