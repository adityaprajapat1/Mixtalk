# MixTalk — Meet. Talk. Connect.

**18+ adults-only stranger communication platform** with real matching, WebSocket chat, WebRTC signaling, and admin moderation.

---

## What is implemented (real backend)

### Matching engine (`src/lib/matching.ts` + Redis)
- Mode-specific queues (`text` / `voice` / `video`)
- Block list respect
- Recent-skip exclusion (30 min)
- Ban / suspension checks
- Light gender balancing (prefer opposite when available; never guaranteed)
- Honest empty state when no eligible users (HTTP 202 searching → eventually no-users)
- In-memory fallback when `REDIS_URL` is unset (single-process only)

### Session management (`src/lib/session.ts`)
- Server-generated temporary session IDs
- Session-scoped nicknames (stable across skips)
- Active session set for online counter
- Privacy-preserving approximate region from headers

### WebSocket server (`server/ws-server.ts`)
- Auth by session ID
- Real-time text messages (no fake delivery)
- Typing indicators
- Match end / partner disconnect events
- WebRTC signaling: offer, answer, ICE candidates

### WebRTC (`src/lib/webrtc.ts` + `/api/webrtc-config`)
- STUN servers always available
- TURN credentials injected **only from server env** (never in frontend bundle)
- getUserMedia for voice/video with mic/camera toggles

### Admin auth (`src/lib/admin-auth.ts`)
- bcrypt password verification
- JWT httpOnly cookie (`mt_admin_session`)
- TOTP 2FA integration point (`ADMIN_TOTP_SECRET`)
- RBAC: `MODERATOR` < `ADMIN` < `SUPER_ADMIN`
- Bootstrap admin from env (`ADMIN_EMAIL` + `ADMIN_PASSWORD_HASH`)

### Reports / Blocks
- Reports stored in Redis (+ Prisma when DB available)
- Blocks prevent future matching
- Match ended on block

### Online counter
- Real aggregate from active session set
- No hard-coded or random numbers

---


## Setup & verification

```bash
# 1. Install dependencies (retry-safe)
npm run setup
# or: npm install

# 2. Configure .env.local (created by setup or copy from .env.example)
#    Required for admin: SESSION_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD_HASH
#    Hash password:
npx tsx scripts/hash-password.ts "YourStrongPassword"

# 3. Health check (reports READY / NOT CONFIGURED / CONNECTION FAILED / DEPENDENCY INSTALL FAILED)
npm run health

# 4. Run (two terminals)
npm run dev       # Next.js app
npm run dev:ws    # WebSocket server (text + WebRTC signaling)
```

Optional services (set in `.env.local`, then re-run `npm run health`):
- `DATABASE_URL` — PostgreSQL for durable reports/bans/admin users; then `npx prisma db push`
- `REDIS_URL` — multi-process matching queues
- `TURN_SERVER` / `TURN_USERNAME` / `TURN_PASSWORD` — reliable WebRTC behind NAT
- `ADMIN_TOTP_SECRET` — production 2FA

**Do not claim production-ready until `npm run health` shows core items READY and external services you rely on are connected.**


## Quick start

```bash
cd mixtalk
cp .env.example .env.local
# Edit .env.local — at minimum set SESSION_SECRET (32+ chars)

npm install

# Terminal 1 — Next.js
npm run dev

# Terminal 2 — WebSocket server
npm run dev:ws
```

Open http://localhost:3000

### Admin password hash

```bash
npx tsx scripts/hash-password.ts "YourStrongPassword"
# Paste output into ADMIN_PASSWORD_HASH
```

### Database (optional but recommended)

```bash
# Set DATABASE_URL in .env.local
npx prisma generate
npx prisma db push
```

---

## Services that require external credentials

| Service | Env vars | Required for |
|---------|----------|--------------|
| **Redis** | `REDIS_URL` | Multi-process matching, durable queues. Falls back to memory. |
| **PostgreSQL** | `DATABASE_URL` | Persistent reports, bans, admin users, audit logs. |
| **Admin auth** | `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH`, `SESSION_SECRET` | Admin login. |
| **2FA** | `ADMIN_TOTP_SECRET` | Production admin 2FA (base32 TOTP). |
| **TURN** | `TURN_SERVER`, `TURN_USERNAME`, `TURN_PASSWORD` | Reliable WebRTC behind NATs. STUN works without this. |
| **WebSocket URL** | `NEXT_PUBLIC_WS_URL`, `WS_PORT` | Browser → WS server connection. |

Without Redis/Postgres the platform still runs with honest empty matching and in-memory state. **No fake users or counters are ever shown.**

---

## Architecture

```
Browser
  ├── Next.js (pages + API routes)
  │     ├── /api/match      → matching engine
  │     ├── /api/session    → session create/update
  │     ├── /api/online     → active count
  │     ├── /api/report|block
  │     ├── /api/webrtc-config  (TURN secrets stay server-side)
  │     └── /api/admin/*
  └── WebSocket (:3001/ws)
        ├── text messages
        ├── typing
        └── WebRTC signaling

Shared state: Redis (or memory) + optional Prisma/Postgres
```

---

## Security notes

- Admin credentials exist **only** in server env / DB hashes
- Session secret never exposed to client
- TURN passwords only returned via authenticated-style config endpoint (server-side env)
- httpOnly, Secure, SameSite cookies for admin
- Age gate is a UI gate only — stronger age-assurance is an integration point

---

## Project structure

```
src/app/           pages + API routes
src/components/    UI (preserved MixTalk design)
src/lib/           redis, session, matching, admin-auth, webrtc, db
server/ws-server.ts
prisma/schema.prisma
scripts/hash-password.ts
```

---

## License

All rights reserved by the project owner.
