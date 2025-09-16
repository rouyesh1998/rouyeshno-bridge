// server.js  (ESM, Node 18+)

// ---------- Imports ----------
import express from "express";
import http from "http";
import cors from "cors";
import { Server as SocketIO } from "socket.io";
import Redis from "ioredis";

// ---------- ENV ----------
const PORT = process.env.PORT || 3000;

// ALLOW_ORIGIN را در Render به صورت "https://rouyeshno.ir,https://www.rouyeshno.ir" بگذار.
// اینجا به آرایه تبدیلش می‌کنیم تا CORS درست عمل کند.
const ORIGINS = (process.env.ALLOW_ORIGIN || "*")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const REDIS_URL = process.env.REDIS_URL || ""; // rediss://...  یا redis://...

// ---------- Redis ----------
const redis = REDIS_URL
  ? new Redis(REDIS_URL, { tls: REDIS_URL.startsWith("rediss://") ? {} : undefined })
  : null;

if (redis) {
  redis.on("error", e => console.error("Redis error:", e.message));
}

// ---------- Express / HTTP ----------
const app = express();
app.use(express.json());
app.use(cors({ origin: ORIGINS.includes("*") ? "*" : ORIGINS, credentials: true }));

app.get("/healthz", (req, res) => res.type("text").send("ok"));
app.get("/", (req, res) => res.send("bridge up"));

const server = http.createServer(app);

// ---------- Socket.IO ----------
const io = new SocketIO(server, {
  cors: { origin: ORIGINS.includes("*") ? "*" : ORIGINS, credentials: true },
  path: "/socket.io",
  transports: ["websocket"],
});

// تاریخچه در Redis
async function readHistory(sessionId) {
  if (!redis) return [];
  const key = `chat:${sessionId}`;
  const items = await redis.lrange(key, 0, -1);
  return items
    .map(s => { try { return JSON.parse(s); } catch { return null; } })
    .filter(Boolean);
}
async function saveMsg(sessionId, msg) {
  if (!redis) return;
  const key = `chat:${sessionId}`;
  await redis.rpush(key, JSON.stringify(msg));
  await redis.expire(key, 60 * 60 * 24 * 7); // 7 روز
}

// ---------- Connection Handler ----------
io.on("connection", async (socket) => {
  // 1) فقط sessionId ادعایی را قبول کن؛ نبود؟ یک‌بار بساز و به کلاینت اعلام کن
  let claimed =
    socket.handshake.auth?.sessionId?.toString().trim() ||
    socket.handshake.query?.sessionId?.toString().trim() ||
    "";

  if (!claimed) {
    claimed = `s-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    console.warn("[server] client WITHOUT sessionId → assigning:", claimed);
  } else {
    console.log("[server] client WITH sessionId:", claimed);
  }
  const sessionId = claimed;

  socket.data.sessionId = sessionId;
  socket.join(sessionId);
  socket.emit("session", { sessionId });

  // 2) تاریخچه
  try {
    const hist = await readHistory(sessionId);
    console.log("[server] history count for", sessionId, "=", hist.length);
    socket.emit("history", hist);
  } catch (e) {
    console.error("[server] history error:", e.message);
  }

  // 3) پیام از کلاینت
  socket.on("client_message", async ({ text }) => {
    const trimmed = (text || "").toString().trim();
    if (!trimmed) return;
    const msg = { from: "user", text: trimmed, ts: Date.now() };
    await saveMsg(sessionId, msg);
    io.to(sessionId).emit("server_message", { from: "sys", text: "پیام شما ثبت شد ✅" });
  });
});

// ---------- Start ----------
server.listen(PORT, () => {
  console.log("Bridge listening on", PORT, "origins:", ORIGINS);
});
