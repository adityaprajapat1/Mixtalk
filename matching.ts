/**
 * Real matching engine.
 * Uses Redis sets as mode-specific queues. No fake users.
 * Respects blocks, recent skips, bans/suspensions, and light gender balancing.
 */

import { randomUUID } from "crypto";
import { getRedis, Keys } from "./redis";
import {
  getSession,
  updateSession,
  isBlocked,
  wasRecentlySkipped,
  addRecentSkip,
  isSessionBannedOrSuspended,
  type CommMode,
  type SessionData,
} from "./session";

export interface MatchResult {
  matchId: string;
  partnerId: string;
  partnerNickname: string;
  partnerGender: string | null;
}

const MATCH_TIMEOUT_MS = 45_000;

/**
 * Enter the matching pool for a mode. Returns a match if one is found immediately,
 * otherwise the caller should poll or wait via WebSocket.
 */
export async function findMatch(
  sessionId: string,
  mode: CommMode
): Promise<MatchResult | null> {
  const status = await isSessionBannedOrSuspended(sessionId);
  if (status.banned || status.suspended) {
    return null;
  }

  const me = await getSession(sessionId);
  if (!me || !me.isActive) return null;

  // Ensure mode is set and we're in the right queue
  await updateSession(sessionId, { mode, matchId: null, partnerId: null });

  const redis = getRedis();
  const queueKey = Keys.queue(mode);

  // Remove self from queue first (re-entry)
  await redis.srem(queueKey, sessionId);

  const candidates = await redis.smembers(queueKey);

  // Filter eligible partners
  const eligible: string[] = [];
  for (const candidateId of candidates) {
    if (candidateId === sessionId) continue;

    const partner = await getSession(candidateId);
    if (!partner || !partner.isActive || partner.matchId) {
      // Stale — remove from queue
      await redis.srem(queueKey, candidateId);
      continue;
    }

    const partnerStatus = await isSessionBannedOrSuspended(candidateId);
    if (partnerStatus.banned || partnerStatus.suspended) {
      await redis.srem(queueKey, candidateId);
      continue;
    }

    if (await isBlocked(sessionId, candidateId)) continue;
    if (await wasRecentlySkipped(sessionId, candidateId)) continue;
    if (await wasRecentlySkipped(candidateId, sessionId)) continue;

    eligible.push(candidateId);
  }

  // Light gender balancing: prefer opposite gender when available, never guarantee
  let selected: string | null = null;
  if (me.gender && eligible.length > 1) {
    const oppositeIds: string[] = [];
    for (const id of eligible) {
      const p = await getSession(id);
      if (p && p.gender && p.gender !== me.gender) oppositeIds.push(id);
    }
    if (oppositeIds.length > 0) {
      selected = oppositeIds[Math.floor(Math.random() * oppositeIds.length)];
    }
  }
  if (!selected && eligible.length > 0) {
    selected = eligible[Math.floor(Math.random() * eligible.length)];
  }

  if (selected) {
    // Pair them
    await redis.srem(queueKey, selected);
    return await createMatch(sessionId, selected, mode);
  }

  // No partner — join queue and wait
  await redis.sadd(queueKey, sessionId);
  return null;
}

async function createMatch(
  userAId: string,
  userBId: string,
  mode: CommMode
): Promise<MatchResult> {
  const matchId = randomUUID();
  const redis = getRedis();

  const a = await getSession(userAId);
  const b = await getSession(userBId);
  if (!a || !b) throw new Error("Session disappeared during match");

  const matchPayload = {
    id: matchId,
    userAId,
    userBId,
    mode,
    status: "matched",
    startedAt: new Date().toISOString(),
  };

  await redis.set(Keys.match(matchId), JSON.stringify(matchPayload), "EX", 60 * 60);

  await updateSession(userAId, {
    matchId,
    partnerId: userBId,
    mode,
  });
  await updateSession(userBId, {
    matchId,
    partnerId: userAId,
    mode,
  });

  // Return from A's perspective
  return {
    matchId,
    partnerId: userBId,
    partnerNickname: b.nickname,
    partnerGender: b.gender,
  };
}

/**
 * Leave current match (skip / end). Optionally exclude partner from immediate rematch.
 */
export async function endMatch(
  sessionId: string,
  opts: { skip?: boolean; reason?: string } = {}
): Promise<void> {
  const me = await getSession(sessionId);
  if (!me) return;

  const redis = getRedis();

  if (me.mode) {
    await redis.srem(Keys.queue(me.mode), sessionId);
  }

  if (me.matchId && me.partnerId) {
    if (opts.skip) {
      await addRecentSkip(sessionId, me.partnerId!);
    }

    // Clear partner's match state
    const partner = await getSession(me.partnerId);
    if (partner && partner.matchId === me.matchId) {
      await updateSession(me.partnerId, {
        matchId: null,
        partnerId: null,
      });
    }

    // Mark match ended
    const raw = await redis.get(Keys.match(me.matchId));
    if (raw) {
      const match = JSON.parse(raw);
      match.status = "ended";
      match.endedAt = new Date().toISOString();
      match.endReason = opts.reason || (opts.skip ? "skip" : "end");
      await redis.set(Keys.match(me.matchId), JSON.stringify(match), "EX", 60 * 30);
    }
  }

  await updateSession(sessionId, {
    matchId: null,
    partnerId: null,
  });
}

/**
 * Get match details if still active.
 */
export async function getMatch(matchId: string) {
  const redis = getRedis();
  const raw = await redis.get(Keys.match(matchId));
  if (!raw) return null;
  return JSON.parse(raw);
}

/**
 * Count users currently in a mode queue (searching).
 */
export async function getQueueSize(mode: CommMode): Promise<number> {
  const redis = getRedis();
  return redis.scard(Keys.queue(mode));
}
