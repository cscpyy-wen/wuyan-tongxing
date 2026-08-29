import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { AppConfig } from "./config.js";

export interface AuthPrincipal {
  kind: "user" | "admin";
  sub: string;
  exp: number;
}

type EncryptionPurpose = "provider-target" | "sensitive-json";

const TOKEN_MAX_TTL_SECONDS = 25 * 3_600;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_PROVIDER_TARGET_BYTES = 512;
const MAX_SENSITIVE_JSON_BYTES = 512 * 1024;

function decodeCanonicalBase64Url(raw: string, field: string, minimumBytes: number, maximumBytes: number): Buffer {
  if (!BASE64URL_PATTERN.test(raw)) throw new Error(`Invalid ${field}`);
  const decoded = Buffer.from(raw, "base64url");
  if (decoded.length < minimumBytes || decoded.length > maximumBytes || decoded.toString("base64url") !== raw) {
    throw new Error(`Invalid ${field}`);
  }
  return decoded;
}

const encode = (value: string): string => Buffer.from(value).toString("base64url");
const decode = (value: string): string => Buffer.from(value, "base64url").toString("utf8");

export function hashIdentifier(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

export function issueToken(principal: Omit<AuthPrincipal, "exp">, secret: string, ttlSeconds = 3_600): string {
  const body = encode(JSON.stringify({ ...principal, exp: Math.floor(Date.now() / 1_000) + ttlSeconds }));
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function verifyToken(token: string, secret: string): AuthPrincipal | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  if (!body || !signature || !BASE64URL_PATTERN.test(body) || !BASE64URL_PATTERN.test(signature)) return null;
  if (Buffer.from(body, "base64url").toString("base64url") !== body) return null;
  const expected = createHmac("sha256", secret).update(body).digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.toString("base64url") !== signature) return null;
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const parsed = JSON.parse(decode(body)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const principal = parsed as Partial<AuthPrincipal>;
    const keys = Object.keys(principal);
    const now = Math.floor(Date.now() / 1_000);
    if (keys.length !== 3 || !keys.includes("kind") || !keys.includes("sub") || !keys.includes("exp")) return null;
    if (typeof principal.sub !== "string" || principal.sub.length < 1 || principal.sub.length > 256) return null;
    if (principal.kind !== "user" && principal.kind !== "admin") return null;
    if (!Number.isSafeInteger(principal.exp) || principal.exp! <= now || principal.exp! > now + TOKEN_MAX_TTL_SECONDS) return null;
    return principal as AuthPrincipal;
  } catch {
    return null;
  }
}

export function principalFromRequest(request: FastifyRequest, config: AppConfig): AuthPrincipal | null {
  const header = request.headers.authorization;
  const match = typeof header === "string" ? /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(header) : null;
  return match?.[1] ? verifyToken(match[1], config.tokenSecret) : null;
}

export function safeEqual(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function encryptionKey(raw: string): Buffer {
  try {
    const decoded = Buffer.from(raw, "base64");
    if (decoded.length === 32) return decoded;
  } catch {
    // Development values are deliberately derived; production config rejects placeholders.
  }
  return createHash("sha256").update(raw).digest();
}

function purposeKey(raw: string, purpose: EncryptionPurpose): Buffer {
  return createHmac("sha256", encryptionKey(raw)).update(`wuyan-aead-v1:${purpose}`).digest();
}

function additionalData(purpose: EncryptionPurpose): Buffer {
  return Buffer.from(`wuyan-aead-v1:${purpose}`, "utf8");
}

function encryptAead(value: string, config: AppConfig, purpose: EncryptionPurpose): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", purposeKey(config.encryptionKey, purpose), nonce);
  cipher.setAAD(additionalData(purpose));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", nonce, tag, encrypted].map((part) => typeof part === "string" ? part : part.toString("base64url")).join(".");
}

function decryptAead(value: string, config: AppConfig, purpose: EncryptionPurpose): string {
  const parts = value.split(".");
  if (parts.length === 4 && parts[0] === "v1") {
    const [, nonceRaw, tagRaw, encryptedRaw] = parts;
    if (!nonceRaw || !tagRaw || !encryptedRaw) throw new Error("Invalid encrypted value");
    const nonce = decodeCanonicalBase64Url(nonceRaw, "encrypted nonce", 12, 12);
    const tag = decodeCanonicalBase64Url(tagRaw, "encrypted authentication tag", 16, 16);
    const encrypted = decodeCanonicalBase64Url(
      encryptedRaw,
      "encrypted ciphertext",
      1,
      purpose === "provider-target" ? MAX_PROVIDER_TARGET_BYTES : MAX_SENSITIVE_JSON_BYTES
    );
    const decipher = createDecipheriv("aes-256-gcm", purposeKey(config.encryptionKey, purpose), nonce);
    decipher.setAAD(additionalData(purpose));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  }

  // Development builds can read pre-v1 local data long enough to export it. Production fails closed.
  if (config.nodeEnv === "production") throw new Error("Legacy encrypted value is not accepted in production");
  const [nonceRaw, tagRaw, encryptedRaw] = parts;
  if (parts.length !== 3 || !nonceRaw || !tagRaw || !encryptedRaw) throw new Error("Invalid encrypted value");
  const nonce = decodeCanonicalBase64Url(nonceRaw, "legacy encrypted nonce", 12, 12);
  const tag = decodeCanonicalBase64Url(tagRaw, "legacy encrypted authentication tag", 16, 16);
  const encrypted = decodeCanonicalBase64Url(
    encryptedRaw,
    "legacy encrypted ciphertext",
    1,
    purpose === "provider-target" ? MAX_PROVIDER_TARGET_BYTES : MAX_SENSITIVE_JSON_BYTES
  );
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(config.encryptionKey), nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

export function encryptProviderTarget(value: string, config: AppConfig): string {
  return encryptAead(value, config, "provider-target");
}

export function decryptProviderTarget(value: string, config: AppConfig): string {
  return decryptAead(value, config, "provider-target");
}

interface EncryptedEnvelope {
  alg: "A256GCM";
  ciphertext: string;
}

export function encryptSensitiveJson(value: unknown, config: AppConfig): EncryptedEnvelope | null {
  if (value === null) return null;
  return { alg: "A256GCM", ciphertext: encryptAead(JSON.stringify(value), config, "sensitive-json") };
}

export function decryptSensitiveJson(value: unknown, config: AppConfig): unknown {
  if (value === null) return null;
  if (!value || typeof value !== "object") throw new Error("Encrypted payload envelope is missing");
  const envelope = value as Partial<EncryptedEnvelope>;
  if (envelope.alg !== "A256GCM" || typeof envelope.ciphertext !== "string") {
    throw new Error("Encrypted payload envelope is invalid");
  }
  return JSON.parse(decryptAead(envelope.ciphertext, config, "sensitive-json")) as unknown;
}
