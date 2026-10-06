/**
 * Server-side session management.
 * Sessions are temporary guest identities — no permanent accounts for basic users.
 */

import { getRedis, Keys } from "./redis";
import { randomUUID } from "crypto";

export type Gender = "boy" | "girl";
export type CommMode = "text" | "voice" | "video";

export interface SessionData {
  id: string;
  nickname: string;
  gender: Gender | null;
  mode: CommMode | null;
  approxRegion: string | null;
  isActive: boolean;
  isBanned: boolean;
  isSuspended: boolean;
  suspendUntil: string | null;
  matchId: string | null;
  partnerId: string | null;
  createdAt: string;
  lastSeenAt: string;
}

const SESSION_TTL = 60 * 60 * 4; // 4 hours
const SKIP_TTL = 60 * 30; // 30 min recent-skip exclusion

const BOY_NICKS = [
  "Nova", "Atlas", "Orion", "Kai", "Zen", "Axel", "Leo", "River", "Ash", "Finn",
  "Jett", "Cruz", "Blake", "Cole", "Drew", "Evan", "Gray", "Hayes", "Ian", "Jude",
];
const GIRL_NICKS = [
  "Luna", "Aria", "Nova", "Iris", "Sage", "Willow", "Eden", "Skye", "Quinn", "Remy",
  "Blair", "Casey", "Drew", "Ellis", "Finley", "Harper", "Indie", "Jules", "Kennedy", "Lane",
];

export function generateNickname(gender: Gender | null): string {
  const pool = gender === "girl" ? GIRL_NICKS : BOY_NICKS;
  const base = pool[Math.floor(Math.random() * pool.length)];
  const num = Math.floor(Math.random() * 900) + 100;
  return `${base}${num}`;
}

export async function createSession(opts: {
  gender?: Gender | null;
  approxRegion?: string | null;
}): Promise<SessionData> {
  const redis = getRedis();
  const id = randomUUID();
  const nickname = generateNickname(opts.gender ?? null);
  const now = new Date().toISOString();

  const data: SessionData = {
    id,
    nickname,
    gender: opts.gender ?? null,
    mode: null,
    approxRegion: opts.approxRegion ?? null,
    isActive: true,
    isBanned: false,
    isSuspended: false,
    suspendUntil: null,
    matchId: null,
    partnerId: null,
    createdAt: now,
    lastSeenAt: now,
  };

  await redis.set(Keys.session(id), JSON.stringify(data), "EX", SESSION_TTL);
  await redis.sadd(Keys.activeSessions, id);
  return data;
}

export async function getSession(id: string): Promise<SessionData | null> {
  const redis = getRedis();
  const raw = await redis.get(Keys.session(id));
  if (!raw) return null;
  return JSON.parse(raw) as SessionData;
}

export async function updateSession(
  id: string,
  patch: Partial<SessionData>
): Promise<SessionData | null> {
  const existing = await getSession(id);
  if (!existing) return null;
  const updated: SessionData = {
    ...existing,
    ...patch,
    lastSeenAt: new Date().toISOString(),
  };
  const redis = getRedis();
  await redis.set(Keys.session(id), JSON.stringify(updated), "EX", SESSION_TTL);
  return updated;
}

export async function touchSession(id: string): Promise<void> {
  await updateSession(id, {});
}

export async function deactivateSession(id: string): Promise<void> {
  const redis = getRedis();
  const session = await getSession(id);
  if (session) {
    // Leave any queue
    if (session.mode) {
      await redis.srem(Keys.queue(session.mode), id);
    }
    await updateSession(id, {
      isActive: false,
      matchId: null,
      partnerId: null,
      mode: null,
    });
  }
  await redis.srem(Keys.activeSessions, id);
}

export async function getActiveCount(): Promise<number> {
  const redis = getRedis();
  // Clean stale members is expensive; scard is approximate but honest
  return redis.scard(Keys.activeSessions);
}

export async function isBlocked(a: string, b: string): Promise<boolean> {
  const redis = getRedis();
  const ab = await redis.sismember(Keys.blocks(a), b);
  const ba = await redis.sismember(Keys.blocks(b), a);
  return ab === 1 || ba === 1;
}

export async function addBlock(blockerId: string, blockedId: string): Promise<void> {
  const redis = getRedis();
  await redis.sadd(Keys.blocks(blockerId), blockedId);
  // Persist longer — blocks should outlive short sessions
  // In production these also go to Postgres
}

export async function addRecentSkip(sessionId: string, partnerId: string): Promise<void> {
  const redis = getRedis();
  const key = Keys.recentSkips(sessionId);
  await redis.sadd(key, partnerId);
  await redis.expire(key, SKIP_TTL);
}

export async function wasRecentlySkipped(sessionId: string, partnerId: string): Promise<boolean> {
  const redis = getRedis();
  return (await redis.sismember(Keys.recentSkips(sessionId), partnerId)) === 1;
}

export async function isSessionBannedOrSuspended(id: string): Promise<{ banned: boolean; suspended: boolean }> {
  const session = await getSession(id);
  if (!session) return { banned: true, suspended: true };
  if (session.isBanned) return { banned: true, suspended: false };
  if (session.isSuspended && session.suspendUntil) {
    if (new Date(session.suspendUntil) > new Date()) {
      return { banned: false, suspended: true };
    }
    // Suspension expired
    await updateSession(id, { isSuspended: false, suspendUntil: null });
  }
  return { banned: false, suspended: false };
}
