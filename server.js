import express from "express";
import http from "http";
import cors from "cors";
import { Server as SocketIO } from "socket.io";
import Redis from "ioredis";

// ====== ENV ======
const PORT = process.env.PORT || 3000;
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";
const REDIS_URL = process.env.REDIS_URL || ""; // rediss://default:xxxx@host:6379

// ====== Redis ======
let redis = null;
if (REDIS_URL) {
  redis = new Redis(REDIS_URL, {
    tls: REDIS_URL.startsWith("rediss://") ? {} : undefined
  });
  redis.on("error", (e) => console.error("Redis error:", e.message));
}

// ====== App/Server ======
const app = express();
const server = http.createServer(app);

app.use(cors({ origin: ALLOW_ORIGIN, credentials: true }));
app.use(express.json());

// Health
app.get("/healthz", (req, res) => res.type("text").send("ok"));

// روت ساده برای تست
app.get("/", (req, res) => res.send("bridge up"));

// ====== Socket.IO ======
const io = new SocketIO(server, {
  cors: { origin: ALLOW_ORIGIN, credentials: true },
  path: "/socket.io",
  transports: ["websocket"]
});

// تاریخچه را از Redis بخوان
async function readHistory(sessionId) {
  if (!redis) return [];
  const key = `chat:${sessionId}`;
  const items = await redis.lrange(key, 0, -1);
  return items.map((s) => {
    try { return JSON.parse(s); } catch { return null; }
  }).filter(Boolean);
}

// پیام جدید را ذخیره کن
async function saveMsg(sessionId, msg) {
  if (!redis) return;
  const key = `chat:${sessionId}`;
  await redis.rpush(key, JSON.stringify(msg));
  await redis.expire(key, 60 * 60 * 24 * 7); // 7 روز
}

io.on("connection", async (socket) => {
  // sessionId از auth یا پرس‌وجو بیاد
  const sessionId =
    socket.handshake.auth?.sessionId ||
    socket.handshake.query?.sessionId ||
    ("s-" + socket.id);

  // تاریخچه برای همین کاربر
  try {
    const hist = await readHistory(sessionId);
    socket.emit("history", hist);
  } catch (e) {
    console.error("history error:", e.message);
  }

  // پیام از کلاینت
  socket.on("client_message", async ({ text }) => {
    const trimmed = (text || "").toString().trim();
    if (!trimmed) return;
    const msg = { from: "user", text: trimmed, ts: Date.now() };
    await saveMsg(sessionId, msg);
    // (اختیاری) همینجا می‌توانی برای تلگرام بفرستی، فعلا خاموش.
  });

  // اگر خواستی از تلگرام پاسخ بدهی، سرور باید این را emit کند:
  // io.to(socket.id).emit("server_message", {from:"admin", text:"پاسخ"});
});

// Start
server.listen(PORT, () => {
  console.log("Bridge listening on", PORT);
});
