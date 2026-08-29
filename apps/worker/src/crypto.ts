import { createDecipheriv, createHash, createHmac } from "node:crypto";

function encryptionKey(raw: string): Buffer {
  const decoded = Buffer.from(raw, "base64");
  return decoded.length === 32 ? decoded : createHash("sha256").update(raw).digest();
}

export function decryptProviderTarget(value: string, rawKey: string): string {
  const [version, nonceRaw, tagRaw, encryptedRaw] = value.split(".");
  if (version !== "v1" || !nonceRaw || !tagRaw || !encryptedRaw || value.split(".").length !== 4) {
    throw new Error("Invalid encrypted provider target");
  }
  const nonce = Buffer.from(nonceRaw, "base64url");
  const tag = Buffer.from(tagRaw, "base64url");
  if (nonce.length !== 12 || tag.length !== 16) throw new Error("Invalid encrypted provider target");
  const purposeKey = createHmac("sha256", encryptionKey(rawKey)).update("wuyan-aead-v1:provider-target").digest();
  const decipher = createDecipheriv("aes-256-gcm", purposeKey, nonce);
  decipher.setAAD(Buffer.from("wuyan-aead-v1:provider-target", "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(encryptedRaw, "base64url")), decipher.final()]).toString("utf8");
}
