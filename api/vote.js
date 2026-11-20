// Best Dresser Pair vote — one serverless endpoint for host + voters.
// Storage: Upstash Redis REST (env KV_REST_API_URL / KV_REST_API_TOKEN or
// UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN). Without them it falls
// back to in-memory state, which is only good for local testing.
// Host actions need env BESTDRESSER_ADMIN_KEY.

const crypto = require("crypto");

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const ADMIN_KEY = process.env.BESTDRESSER_ADMIN_KEY || "";
const MAX_RANGE = 300;

// ---------- storage ----------
const mem = { state: null, votes: {}, voters: new Set() };

async function redis(cmds) {
  const r = await fetch(`${REDIS_URL}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error(`Redis ${r.status}`);
  const out = await r.json();
  return out.map((x) => {
    if (x.error) throw new Error(x.error);
    return x.result;
  });
}

const K = { state: "bd:state", votes: (s) => `bd:votes:${s}`, voters: (s) => `bd:voters:${s}` };

async function getState() {
  if (!REDIS_URL) return mem.state;
  const [raw] = await redis([["GET", K.state]]);
  return raw ? JSON.parse(raw) : null;
}

async function setState(st) {
  if (!REDIS_URL) { mem.state = st; return; }
  await redis([["SET", K.state, JSON.stringify(st)]]);
}

async function startSession(st) {
  if (!REDIS_URL) { mem.state = st; mem.votes = {}; mem.voters = new Set(); return; }
  await redis([["SET", K.state, JSON.stringify(st)]]);
}

// returns "ok" | "dup"
async function castVote(sid, voter, n) {
  if (!REDIS_URL) {
    if (mem.voters.has(voter)) return "dup";
    mem.voters.add(voter);
    mem.votes[n] = (mem.votes[n] || 0) + 1;
    return "ok";
  }
  const [added] = await redis([["SADD", K.voters(sid), voter]]);
  if (!added) return "dup";
  await redis([
    ["HINCRBY", K.votes(sid), String(n), 1],
    ["EXPIRE", K.votes(sid), 60 * 60 * 24 * 30],
    ["EXPIRE", K.voters(sid), 60 * 60 * 24 * 30],
  ]);
  return "ok";
}

async function getTally(sid) {
  if (!REDIS_URL) return { ...mem.votes };
  const [flat] = await redis([["HGETALL", K.votes(sid)]]);
  const t = {};
  for (let i = 0; i < (flat || []).length; i += 2) t[flat[i]] = Number(flat[i + 1]);
  return t;
}

async function voteCount(sid) {
  if (!REDIS_URL) return mem.voters.size;
  const [n] = await redis([["SCARD", K.voters(sid)]]);
  return Number(n) || 0;
}

// ---------- helpers ----------
function publicState(st, extra = {}) {
  if (!st) return { status: "idle", ...extra };
  const out = { status: st.status, sid: st.sid, min: st.min, max: st.max, ...extra };
  // only the winner(s) and their vote count; never the full tally
  if (st.status === "closed") out.result = { winners: st.result.winners, votes: st.result.votes, total: st.result.total };
  return out;
}

function isAdmin(key) {
  if (!ADMIN_KEY || typeof key !== "string") return false;
  const a = Buffer.from(key), b = Buffer.from(ADMIN_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function json(res, code, body) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  let data = "";
  for await (const chunk of req) data += chunk;
  try { return JSON.parse(data || "{}"); } catch { return {}; }
}

// ---------- handler ----------
module.exports = async (req, res) => {
  try {
    if (req.method === "GET") {
      const st = await getState();
      const url = new URL(req.url, "http://x");
      const extra = {};
      if (url.searchParams.get("count") && st && isAdmin(req.headers["x-admin-key"])) {
        extra.count = await voteCount(st.sid);
      }
      return json(res, 200, publicState(st, extra));
    }

    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
    const body = await readBody(req);
    const action = body.action;

    if (action === "vote") {
      const st = await getState();
      if (!st || st.status !== "open") return json(res, 409, { error: "Voting is not open." });
      if (body.sid !== st.sid) return json(res, 409, { error: "This vote session has changed. Please reload." });
      const n = Number(body.number);
      if (!Number.isInteger(n) || n < st.min || n > st.max) return json(res, 400, { error: "Invalid number." });
      const voter = String(body.voter || "");
      if (!/^[a-zA-Z0-9-]{8,64}$/.test(voter)) return json(res, 400, { error: "Invalid voter." });
      const r = await castVote(st.sid, voter, n);
      if (r === "dup") return json(res, 409, { error: "You have already voted.", already: true });
      return json(res, 200, { ok: true, number: n });
    }

    // ---- host-only actions ----
    if (!ADMIN_KEY) return json(res, 500, { error: "Admin key is not configured on the server." });
    if (!isAdmin(body.key)) return json(res, 401, { error: "Wrong admin password." });

    if (action === "login") {
      const st = await getState();
      return json(res, 200, publicState(st, st ? { count: await voteCount(st.sid) } : {}));
    }

    if (action === "start") {
      const min = Number(body.min), max = Number(body.max);
      if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < min)
        return json(res, 400, { error: "Enter a valid number range." });
      if (max - min + 1 > MAX_RANGE) return json(res, 400, { error: `Range can be at most ${MAX_RANGE} numbers.` });
      const st = { status: "open", sid: crypto.randomBytes(6).toString("hex"), min, max, startedAt: Date.now() };
      await startSession(st);
      return json(res, 200, publicState(st, { count: 0 }));
    }

    if (action === "end") {
      const st = await getState();
      if (!st || st.status !== "open") return json(res, 409, { error: "Voting is not open." });
      const tally = await getTally(st.sid);
      let top = 0, winners = [];
      for (const [num, c] of Object.entries(tally)) {
        if (c > top) { top = c; winners = [Number(num)]; }
        else if (c === top && c > 0) winners.push(Number(num));
      }
      winners.sort((a, b) => a - b);
      const total = Object.values(tally).reduce((a, b) => a + b, 0);
      st.status = "closed";
      st.endedAt = Date.now();
      st.result = { winners, votes: top, total };
      await setState(st);
      return json(res, 200, publicState(st));
    }

    if (action === "reset") {
      await setState(null);
      return json(res, 200, publicState(null));
    }

    return json(res, 400, { error: "Unknown action." });
  } catch (e) {
    console.error(e);
    return json(res, 500, { error: "Server error. Please try again." });
  }
};
