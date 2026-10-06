/**
 * MixTalk WebSocket server — text messaging + WebRTC signaling.
 * Run: npx tsx server/ws-server.ts
 * Requires REDIS_URL (or uses memory store) and shares session state with Next.js APIs.
 */

import { createServer } from "http";
import { Server, Socket } from "socket.io";
import {
  getSession,
  updateSession,
  touchSession,
  deactivateSession,
} from "../src/lib/session";
import { endMatch, getMatch, findMatch } from "../src/lib/matching";
import { getActiveCount } from "../src/lib/session";

const PORT = parseInt(process.env.WS_PORT || "3001", 10);
const ORIGIN = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

interface ClientMeta {
  sessionId: string;
  matchId: string | null;
}

const meta = new WeakMap<Socket, ClientMeta>();

const httpServer = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ service: "mixtalk-ws", status: "ok" }));
});

const io = new Server(httpServer, {
  cors: { origin: ORIGIN, methods: ["GET", "POST"], credentials: true },
  path: "/ws",
});

io.on("connection", (socket) => {
  console.log("[ws] connected", socket.id);

  socket.on("auth", async (payload: { sessionId: string }, cb) => {
    try {
      const session = await getSession(payload.sessionId);
      if (!session || !session.isActive) {
        cb?.({ ok: false, error: "Invalid session" });
        socket.disconnect(true);
        return;
      }
      meta.set(socket, { sessionId: session.id, matchId: session.matchId });
      socket.join(`session:${session.id}`);
      if (session.matchId) {
        socket.join(`match:${session.matchId}`);
        meta.set(socket, { sessionId: session.id, matchId: session.matchId });
      }
      await touchSession(session.id);
      cb?.({ ok: true, nickname: session.nickname });
    } catch (e) {
      cb?.({ ok: false, error: "Auth failed" });
    }
  });

  socket.on("join_match", async (payload: { matchId: string }, cb) => {
    const m = meta.get(socket);
    if (!m) return cb?.({ ok: false, error: "Not authenticated" });
    const match = await getMatch(payload.matchId);
    if (!match) return cb?.({ ok: false, error: "Match not found" });
    if (match.userAId !== m.sessionId && match.userBId !== m.sessionId) {
      return cb?.({ ok: false, error: "Not a participant" });
    }
    socket.join(`match:${payload.matchId}`);
    meta.set(socket, { ...m, matchId: payload.matchId });
    cb?.({ ok: true });
  });

  // Real-time text message
  socket.on(
    "message",
    async (
      payload: { matchId: string; text: string },
      cb?: (r: { ok: boolean; error?: string; id?: string }) => void
    ) => {
      const m = meta.get(socket);
      if (!m) return cb?.({ ok: false, error: "Not authenticated" });
      if (!payload.text || typeof payload.text !== "string") {
        return cb?.({ ok: false, error: "Empty message" });
      }
      const text = payload.text.trim().slice(0, 1000);
      if (!text) return cb?.({ ok: false, error: "Empty message" });

      const match = await getMatch(payload.matchId);
      if (!match || match.status === "ended") {
        return cb?.({ ok: false, error: "Match inactive" });
      }
      if (match.userAId !== m.sessionId && match.userBId !== m.sessionId) {
        return cb?.({ ok: false, error: "Not a participant" });
      }

      const msgId = crypto.randomUUID();
      const msg = {
        id: msgId,
        matchId: payload.matchId,
        from: m.sessionId,
        text,
        ts: Date.now(),
      };

      // Broadcast to match room (both participants)
      io.to(`match:${payload.matchId}`).emit("message", msg);
      cb?.({ ok: true, id: msgId });
    }
  );

  // Typing indicator
  socket.on("typing", (payload: { matchId: string; typing: boolean }) => {
    const m = meta.get(socket);
    if (!m) return;
    socket.to(`match:${payload.matchId}`).emit("typing", {
      from: m.sessionId,
      typing: Boolean(payload.typing),
    });
  });

  // --- WebRTC signaling ---
  socket.on("webrtc:offer", (payload: { matchId: string; sdp: unknown }) => {
    const m = meta.get(socket);
    if (!m) return;
    socket.to(`match:${payload.matchId}`).emit("webrtc:offer", {
      from: m.sessionId,
      sdp: payload.sdp,
    });
  });

  socket.on("webrtc:answer", (payload: { matchId: string; sdp: unknown }) => {
    const m = meta.get(socket);
    if (!m) return;
    socket.to(`match:${payload.matchId}`).emit("webrtc:answer", {
      from: m.sessionId,
      sdp: payload.sdp,
    });
  });

  socket.on("webrtc:ice", (payload: { matchId: string; candidate: unknown }) => {
    const m = meta.get(socket);
    if (!m) return;
    socket.to(`match:${payload.matchId}`).emit("webrtc:ice", {
      from: m.sessionId,
      candidate: payload.candidate,
    });
  });

  // Partner skip/end notification
  socket.on("match:end", async (payload: { matchId: string; reason?: string }) => {
    const m = meta.get(socket);
    if (!m) return;
    await endMatch(m.sessionId, { skip: payload.reason === "skip", reason: payload.reason });
    socket.to(`match:${payload.matchId}`).emit("match:ended", {
      reason: payload.reason || "end",
      by: m.sessionId,
    });
    socket.leave(`match:${payload.matchId}`);
  });

  socket.on("disconnect", async () => {
    const m = meta.get(socket);
    if (m) {
      // Soft touch only — don't fully deactivate so rematch works after brief disconnect
      await touchSession(m.sessionId);
      if (m.matchId) {
        socket.to(`match:${m.matchId}`).emit("partner:disconnected", {
          sessionId: m.sessionId,
        });
      }
    }
    console.log("[ws] disconnected", socket.id);
  });
});

// Periodic online count broadcast
setInterval(async () => {
  try {
    const count = await getActiveCount();
    io.emit("online", { count });
  } catch {
    // ignore
  }
}, 10000);

httpServer.listen(PORT, () => {
  console.log(`[mixtalk-ws] listening on :${PORT} (path /ws)`);
  console.log(`[mixtalk-ws] CORS origin: ${ORIGIN}`);
});
