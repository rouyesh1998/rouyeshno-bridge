// server.js — نسخه‌ی کامل و پایدار (Node 18+, ESM)
import express from "express";
import http from "http";
import cors from "cors";
import { Server as SocketIO } from "socket.io";
import Redis from "ioredis";

const PORT = process.env.PORT || 3000;
const ORIGINS = (process.env.ALLOW_ORIGIN || "*")
  .split(",").map(s => s.trim()).filter(Boolean);
const REDIS_URL = process.env.REDIS_URL || "";

// ---------- Redis ----------
const redis = REDIS_URL
  ? new Redis(REDIS_URL, { tls: REDIS_URL.startsWith("rediss://") ? {} : undefined })
  : null;

if (redis) {
  redis.on("error", e => console.error("Redis error:", e.message));
  redis.on("ready", () => console.log("✅ Redis ready"));
} else {
  console.error("❌ REDIS_URL is empty — history cannot be stored.");
}

// ---------- App/HTTP ----------
const app = express();
app.use(express.json());
app.use(cors({ origin: ORIGINS.includes("*") ? "*" : ORIGINS, credentials: true }));

app.get("/healthz", (req, res) => res.type("text").send("ok"));
app.get("/", (req, res) => res.send("bridge up"));

// دیباگ: سلامت Redis
app.get("/debug/redis", async (req, res) => {
  try {
    if (!redis) throw new Error("Redis not configured");
    const pong = await redis.ping();
    await redis.set("rx:test", "ok", "EX", 60);
    const val = await redis.get("rx:test");
    res.json({ ok: true, ping: pong, sample: val });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// دیباگ: تاریخچه‌ی یک سشن
app.get("/debug/history", async (req, res) => {
  try {
    const sid = String(req.query.sid || "").trim();
    if (!sid) throw new Error("sid required");
    const key = `chat:${sid}`;
    const items = await redis.lrange(key, 0, -1);
    res.json({ ok: true, sid, count: items.length, items: items.map(s => JSON.parse(s)) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

const server = http.createServer(app);

// ---------- Socket.IO ----------
const io = new SocketIO(server, {
  cors: { origin: ORIGINS.includes("*") ? "*" : ORIGINS, credentials: true },
  path: "/socket.io",
  transports: ["websocket"]
});

// ابزار تاریخچه (سخت‌گیر: بدون Redis خطا می‌دهیم)
async function readHistory(sessionId) {
  if (!redis) throw new Error("Redis not configured");
  const key = `chat:${sessionId}`;
  const items = await redis.lrange(key, 0, -1);
  return items.map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
}
async function saveMsg(sessionId, msg) {
  if (!redis) throw new Error("Redis not configured");
  const key = `chat:${sessionId}`;
  await redis.rpush(key, JSON.stringify(msg));
  await redis.expire(key, 60 * 60 * 24 * 7); // ۷ روز
}

// ضدِ اتصال تکراری: فقط یک سوکت برای هر سشن نگه می‌داریم
const active = new Map(); // sessionId -> socketId

io.on("connection", async (socket) => {
  console.log("[server] connect from", socket.handshake.headers.origin || "unknown");

  let claimed =
    socket.handshake.auth?.sessionId?.toString().trim() ||
    socket.handshake.query?.sessionId?.toString().trim() || "";

  if (!claimed) {
    claimed = `s-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    console.warn("[server] WITHOUT sessionId → assigning:", claimed);
  } else {
    console.log("[server] WITH sessionId:", claimed);
  }
  const sessionId = claimed;

  socket.data.sessionId = sessionId;
  socket.join(sessionId);
  socket.emit("session", { sessionId });

  // اگر قبلاً سوکت فعالی برای این سشن داشتیم، آن را می‌بندیم
  const prev = active.get(sessionId);
  if (prev && prev !== socket.id) {
    const old = io.sockets.sockets.get(prev);
    if (old) {
      console.warn("[server] duplicate connection for", sessionId, "→ closing previous", prev);
      try { old.disconnect(true); } catch {}
    }
  }
  active.set(sessionId, socket.id);

  // تاریخچه
  try {
    const hist = await readHistory(sessionId);
    console.log("[server] history count =", hist.length, "for", sessionId);
    socket.emit("history", hist);
  } catch (e) {
    console.error("[server] history load failed:", e.message);
    socket.emit("history", []);
  }

  socket.on("client_message", async ({ text }) => {
    const trimmed = (text || "").toString().trim();
    if (!trimmed) return;
    const msg = { from: "user", text: trimmed, ts: Date.now() };
    try {
      await saveMsg(sessionId, msg);
      console.log("[server] saved msg for", sessionId, ":", trimmed.slice(0, 80));
      io.to(sessionId).emit("server_message", { from: "sys", text: "پیام شما ثبت شد ✅" });
    } catch (e) {
      console.error("[server] save failed:", e.message);
      io.to(sessionId).emit("server_message", { from: "sys", text: "⚠️ ذخیره فعال نیست (Redis)" });
    }
  });

  socket.on("disconnect", () => {
    if (active.get(sessionId) === socket.id) active.delete(sessionId);
  });
});

server.listen(PORT, () => {
  console.log("Bridge listening on", PORT, "origins:", ORIGINS);
});
