// server.js
// ============ Imports ============
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const Redis = require("ioredis");

// ============ App / Server ============
const app = express();
const server = http.createServer(app);

// CORS: از env بگیر، اگر نبود موقتاً همه را باز بگذار
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";

const io = new Server(server, {
  cors: {
    origin: ALLOW_ORIGIN,
    methods: ["GET", "POST"],
    credentials: false,
  },
  // path پیش‌فرض /socket.io است؛ همان را نگه داریم
});

// ============ Redis ============
const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  console.warn("⚠️  REDIS_URL خالی است؛ Persist کار نخواهد کرد.");
}
const redis = REDIS_URL ? new Redis(REDIS_URL) : null;

if (redis) {
  redis.on("connect", () => console.log("✅ Redis connected"));
  redis.on("error", (e) => console.error("❌ Redis error:", e.message));
}

// ============ Helpers ============
const TTL_SECONDS = 60 * 60 * 24 * 30; // 30 روز
const key = (sid) => `chat:${sid}`;

async function loadHistory(sessionId) {
  if (!redis) return [];
  const items = await redis.lrange(key(sessionId), 0, -1);
  return items.map((s) => {
    try { return JSON.parse(s); } catch { return null; }
  }).filter(Boolean);
}

async function saveMessage(sessionId, msg) {
  if (!redis) return;
  await redis.rpush(key(sessionId), JSON.stringify(msg));
  await redis.expire(key(sessionId), TTL_SECONDS);
}

function getSessionId(socket) {
  // 1) از handshake.auth
  let sid = socket.handshake?.auth?.sessionId;
  // 2) اگر نبود، از query
  if (!sid && socket.handshake?.query?.sessionId) {
    sid = socket.handshake.query.sessionId;
  }
  // 3) اگر هیچ نبود، socket.id
  return sid || socket.id;
}

// ============ Routes ============
app.get("/", (_, res) => res.type("text/plain").send("rouyeshno-bridge up"));
app.get("/healthz", (_, res) => res.type("text/plain").send("ok"));

// تست ساده CORS (اختیاری)
app.get("/whoami", (req, res) => {
  res.json({
    ok: true,
    cors_origin: ALLOW_ORIGIN,
    time: new Date().toISOString(),
  });
});

// ============ Socket.IO ============
io.on("connection", async (socket) => {
  let sessionId = getSessionId(socket);
  socket.data.sessionId = sessionId;

  console.log("🔌 connect:", socket.id, "session:", sessionId);

  // اگر بعضی کلاینت‌ها بعد از اتصال هم hello می‌فرستند، هندل کن
  socket.on("hello", async (payload = {}) => {
    if (payload.sessionId && payload.sessionId !== sessionId) {
      sessionId = payload.sessionId;
      socket.data.sessionId = sessionId;
      console.log("👋 hello override session:", sessionId);
    }
    // session و history برگردان
    socket.emit("session", { sessionId });
    const hist = await loadHistory(sessionId);
    socket.emit("history", hist);
  });

  // برای کلاینت‌هایی که hello نمی‌فرستند، همین‌جا history بده
  (async () => {
    socket.emit("session", { sessionId });
    const hist = await loadHistory(sessionId);
    socket.emit("history", hist);
  })();

  // پیام کاربر از وب
  socket.on("client_message", async ({ text }) => {
    const t = String(text || "").trim();
    if (!t) return;

    const msg = { from: "user", text: t, ts: Date.now() };
    await saveMessage(sessionId, msg);

    console.log("📩 user ->", sessionId, ":", t.slice(0, 80));
    // اگر خواستی اینجا به تلگرام هم فوروارد کنی، اضافه کن (اختیاری)
  });

  socket.on("disconnect", (reason) => {
    console.log("🔌 disconnect:", socket.id, "reason:", reason);
  });
});

// ============ Start ============
const PORT = process.env.PORT || 10000; // Render معمولاً همین را می‌دهد
server.listen(PORT, () => {
  console.log("🚀 Server started on", PORT, " | CORS:", ALLOW_ORIGIN);
});
