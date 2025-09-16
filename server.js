// server.js — آماده‌ی Deploy روی Render (Node 18+, ESM)
import express from "express";
import http from "http";
import cors from "cors";
import { Server as SocketIO } from "socket.io";
import Redis from "ioredis";

const PORT = process.env.PORT || 3000;
const ORIGINS = (process.env.ALLOW_ORIGIN || "*").split(",").map(s=>s.trim()).filter(Boolean);
const REDIS_URL = process.env.REDIS_URL || "";

const redis = REDIS_URL ? new Redis(REDIS_URL, { tls: REDIS_URL.startsWith("rediss://") ? {} : undefined }) : null;
if (redis) {
  redis.on("error", e => console.error("Redis error:", e.message));
  redis.on("ready", () => console.log("✅ Redis ready"));
} else {
  console.error("❌ REDIS_URL is empty — history cannot be stored.");
}

const app = express();
app.use(express.json());
app.use(cors({ origin: ORIGINS.includes("*") ? "*" : ORIGINS, credentials: true }));
app.get("/healthz", (req, res) => res.type("text").send("ok"));
app.get("/", (req, res) => res.send("bridge up"));
const server = http.createServer(app);

const io = new SocketIO(server, {
  cors: { origin: ORIGINS.includes("*") ? "*" : ORIGINS, credentials: true },
  path: "/socket.io",
  transports: ["websocket"]
});

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
  await redis.expire(key, 60 * 60 * 24 * 7);
}

io.on("connection", async (socket) => {
  console.log("[server] connect from", socket.handshake.headers.origin || "unknown");

  let claimed = socket.handshake.auth?.sessionId?.toString().trim()
             || socket.handshake.query?.sessionId?.toString().trim()
             || "";
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
      io.to(sessionId).emit("server_message", { from: "sys", text: "پیام شما ثبت شد ✅" });
    } catch (e) {
      console.error("[server] save failed:", e.message);
      io.to(sessionId).emit("server_message", { from: "sys", text: "⚠️ ذخیره فعال نیست (Redis)" });
    }
  });
});

server.listen(PORT, () => {
  console.log("Bridge listening on", PORT, "origins:", ORIGINS);
});
