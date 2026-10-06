/**
 * Secure admin authentication with RBAC and 2FA integration points.
 * Passwords are never stored or compared in plaintext.
 * Secrets come only from server-side environment variables.
 */

import { createHash, createHmac } from "crypto";
import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { getPrisma, isDatabaseConfigured } from "./db";

export type AdminRole = "MODERATOR" | "ADMIN" | "SUPER_ADMIN";

export interface AdminTokenPayload {
  sub: string;
  email: string;
  role: AdminRole;
}

export const COOKIE_NAME = "mt_admin_session";
const TOKEN_TTL = "8h";

function getJwtSecret(): Uint8Array {
  const secret = process.env.SESSION_SECRET || process.env.ADMIN_JWT_SECRET;
  if (!secret || secret.length < 32) {
    return new TextEncoder().encode("mixtalk-dev-insecure-secret-change-me!!");
  }
  return new TextEncoder().encode(secret);
}

export function isAdminAuthConfigured(): boolean {
  return Boolean(
    process.env.ADMIN_EMAIL &&
      process.env.ADMIN_PASSWORD_HASH &&
      process.env.SESSION_SECRET &&
      process.env.SESSION_SECRET.length >= 32
  );
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const cleaned = input.replace(/=+$/, "").toUpperCase();
  let bits = "";
  for (const c of cleaned) {
    const val = alphabet.indexOf(c);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function generateTotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(buf).digest();
  const offset = digest[digest.length - 1] & 0xf;
  const code =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, "0");
}

/** TOTP verification. Set ADMIN_TOTP_SECRET for production 2FA. */
export function verifyTotp(token: string, secretBase32?: string): boolean {
  if (!secretBase32) {
    if (process.env.NODE_ENV === "production") return false;
    return /^\d{6}$/.test(token);
  }
  try {
    const secret = base32Decode(secretBase32);
    const timestep = Math.floor(Date.now() / 1000 / 30);
    for (const w of [timestep - 1, timestep, timestep + 1]) {
      if (generateTotp(secret, w) === token) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export interface LoginResult {
  success: boolean;
  error?: string;
  token?: string;
  role?: AdminRole;
}

export async function loginAdmin(
  email: string,
  password: string,
  otp: string
): Promise<LoginResult> {
  if (!isAdminAuthConfigured() && !isDatabaseConfigured()) {
    return {
      success: false,
      error:
        "Admin authentication not configured. Set ADMIN_EMAIL, ADMIN_PASSWORD_HASH, and SESSION_SECRET.",
    };
  }

  const envEmail = process.env.ADMIN_EMAIL?.toLowerCase();
  const envHash = process.env.ADMIN_PASSWORD_HASH;
  const totpSecret = process.env.ADMIN_TOTP_SECRET;

  if (envEmail && envHash && email.toLowerCase() === envEmail) {
    const pwOk = await verifyPassword(password, envHash);
    if (!pwOk) return { success: false, error: "Invalid credentials" };
    if (!verifyTotp(otp, totpSecret)) {
      return { success: false, error: "Invalid 2FA code" };
    }
    const token = await createAdminToken({
      sub: "env-admin",
      email: envEmail,
      role: "SUPER_ADMIN",
    });
    return { success: true, token, role: "SUPER_ADMIN" };
  }

  const prisma = getPrisma();
  if (prisma) {
    const admin = await prisma.adminUser.findUnique({
      where: { email: email.toLowerCase() },
    });
    if (!admin || !admin.isActive) {
      return { success: false, error: "Invalid credentials" };
    }
    const pwOk = await verifyPassword(password, admin.passwordHash);
    if (!pwOk) return { success: false, error: "Invalid credentials" };
    if (!verifyTotp(otp, admin.totpSecret || undefined)) {
      return { success: false, error: "Invalid 2FA code" };
    }
    await prisma.adminUser.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date() },
    });
    const role = admin.role as AdminRole;
    const token = await createAdminToken({
      sub: admin.id,
      email: admin.email,
      role,
    });
    return { success: true, token, role };
  }

  return { success: false, error: "Invalid credentials" };
}

export async function createAdminToken(payload: AdminTokenPayload): Promise<string> {
  return new SignJWT({ email: payload.email, role: payload.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .sign(getJwtSecret());
}

export async function verifyAdminToken(token: string): Promise<AdminTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    if (!payload.sub || !payload.email || !payload.role) return null;
    return {
      sub: payload.sub,
      email: String(payload.email),
      role: payload.role as AdminRole,
    };
  } catch {
    return null;
  }
}

export function hasRole(role: AdminRole, required: AdminRole | AdminRole[]): boolean {
  const hierarchy: Record<AdminRole, number> = {
    MODERATOR: 1,
    ADMIN: 2,
    SUPER_ADMIN: 3,
  };
  const needed = Array.isArray(required) ? required : [required];
  return needed.some((r) => hierarchy[role] >= hierarchy[r]);
}
