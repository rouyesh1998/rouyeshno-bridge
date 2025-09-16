// server.js
import express from "express";
import http from "http";
import cors from "cors";
import { Server as SocketIO } from "socket.io";
import Redis from "ioredis";

// ====== ENV ======
const PORT = process.env.PORT || 3000;

// ALLOW_ORIGIN در رندر به‌صورت "https://a.com,https://b.com" گذاشته‌اید.
// به آرایه تبدیلش می‌کنیم تا CORS درست کار کند.
const ORIGINS = (process.env.ALLOW_ORIGIN || "*")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// Redis (rediss:// برای TLS)
const REDIS_URL = process.env.REDIS_URL || "";
const redis = REDIS_URL
  ? new Redis(REDIS_URL, { tls: REDIS_URL.startsWith("rediss://") ? {} : undefined })
  : null;

if (redis) {
  redis.on("error", e => console.error("Redis error:", e.message));
}

// Telegram (حداقل‌ترین نیاز)
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;      // لازم
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;      // مقصد پیش‌فرض/ادمین

// ====== App/Server ======
const app = express();
const server = http.createServer(app);

app.use(cors({ origin: ORIGINS.includes("*") ? "*" : ORIGINS, credentials: true }));
app.use(express.json());

// Health
app.get("/healthz", (req, res) => res.type("text").send("ok"));

// روت ساده
app.get("/", (req, res) => res.send("bridge up"));

// ====== ابزارهای Redis ======

// تاریخچهٔ پیام‌های یک سشن
async function readHistory(sessionId) {
  if (!redis) return [];
  const key = `chat:${sessionId}`;
  const items = await redis.lrange(key, 0, -1);
  return items.map(s => { try { return JSON.parse(s); } catch { return null; } })
              .filter(Boolean);
}

async function saveMsg(sessionId, msg) {
  if (!redis) return;
  const key = `chat:${sessionId}`;
  await redis.rpush(key, JSON.stringify(msg));
  await redis.expire(key, 60 * 60 * 24 * 7); // 7 روز نگه‌داری
}

// نگاشت سشن ⇄ مقصد تلگرام
async function loadSession(sessionId) {
  if (!redis) return null;
  const raw = await redis.get(`sess:${sessionId}`);
  return raw ? JSON.parse(raw) : null;
}
async function saveSession(sess) {
  if (!redis) return;
  await redis.set(`sess:${sess.sessionId}`, JSON.stringify(sess));
  // ایندکس معکوس برای پاسخ‌های تلگرام
  if (sess.telegramChatId) {
    const idxKey = `idx:telegram:${sess.telegramChatId}:${sess.telegramTopicId || 0}`;
    await redis.set(idxKey, sess.sessionId);
  }
}
async function findSessionByTelegram(chatId, topicId = 0) {
  if (!redis) return null;
  const idxKey = `idx:telegram:${chatId}:${topicId}`;
  const sid = await redis.get(idxKey);
  return sid ? loadSession(sid) : null;
}

// ====== حداقل ارسال به تلگرام ======
async function tgSendMessage(chatId, text, opts = {}) {
  if (!TG_TOKEN || !chatId) return;
  const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...opts,
  };
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(e => console.error("tgSendMessage error:", e.message));
}

// ====== Socket.IO ======
const io = new SocketIO(server, {
  cors: { origin: ORIGINS.includes("*") ? "*" : ORIGINS, credentials: true },
  path: "/socket.io",
  transports: ["websocket"],
});

// یکپارچه: همیشه از sessionIdِ ادعاشده استفاده کن؛ اگر نبود، بساز ولی به کلاینت اعلامش کن.
io.on("connection", async (socket) => {
  // 1) دریافت/تثبیت sessionId
  let sessionId =
    socket.handshake.auth?.sessionId?.toString().trim() ||
    socket.handshake.query?.sessionId?.toString().trim();

  if (!sessionId) {
    // اگر کلاینت نفرستاده، می‌سازیم و به او اعلام می‌کنیم تا ذخیره کند
    sessionId = `s-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  }
  socket.data.sessionId = sessionId;

  // 2) سشن را از Redis بخوان یا بساز
  let sess = (await loadSession(sessionId)) || {
    sessionId,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    telegramChatId: null,      // می‌توانید بعداً per-session تاپیک بسازید
    telegramTopicId: 0,
  };
  sess.lastSeenAt = Date.now();
  await saveSession(sess);

  // 3) سوکت را در room سشن عضو کن و sessionId را به کلاینت اطلاع بده
  socket.join(sessionId);
  socket.emit("session", { sessionId });

  // 4) تاریخچه را بفرست
  try {
    const hist = await readHistory(sessionId);
    socket.emit("history", hist);
  } catch (e) {
    console.error("history error:", e.message);
  }

  // 5) پیام از کلاینت
  socket.on("client_message", async ({ text }) => {
    const trimmed = (text || "").toString().trim();
    if (!trimmed) return;

    const msg = { from: "user", text: trimmed, ts: Date.now() };
    await saveMsg(sessionId, msg);

    // اگر مقصد تلگرام برای این سشن نداریم، فعلاً به ADMIN_CHAT_ID بفرست
    // (می‌توانید اینجا تاپیک/Thread per-session بسازید و در sess ذخیره کنید)
    let { telegramChatId, telegramTopicId } = sess;
    if (!telegramChatId) {
      telegramChatId = ADMIN_CHAT_ID;
      telegramTopicId = 0;
      sess.telegramChatId = telegramChatId;
      sess.telegramTopicId = telegramTopicId;
      await saveSession(sess);
    }

    // ارسال به تلگرام با prefix سشن برای تشخیص
    await tgSendMessage(
      telegramChatId,
      `<b>[${sessionId}]</b>\n${trimmed}`,
      telegramTopicId ? { message_thread_id: telegramTopicId } : {}
    );

    // بازخورد اختیاری به کلاینت
    io.to(sessionId).emit("server_message", { from: "sys", text: "پیام شما ارسال شد ✅" });
  });

  socket.on("disconnect", () => {
    // نشست در Redis باقی می‌ماند؛ کاری لازم نیست
  });
});

// ====== وب‌هوک تلگرام (اختیاری ولی ضروری برای برگشت پیام) ======
// آدرس وب‌هوک را در BotFather ست کنید: https://<دامنه‌تان>/tg/webhook
app.post("/tg/webhook", async (req, res) => {
  try {
    const update = req.body;
    const msg = update?.message ?? update?.channel_post ?? null;
    if (!msg) return res.json({ ok: true });

    const chatId = msg.chat?.id;
    const threadId = (msg.is_topic_message && msg.message_thread_id) ? msg.message_thread_id : 0;
    const text = msg.text || msg.caption || "";

    // اگر ادمین برای سشن مشخص پاسخ دهد، می‌تواند [sessionId] را ابتدای پیام بگذارد؛
    // یا اگر ایندکس معکوس داریم، مستقیم سشن را پیدا می‌کنیم.
    let sess = await findSessionByTelegram(chatId, threadId);
    if (!sess) {
      // fallback: تلاش برای استخراج [sessionId] از ابتدای پیام
      const m = text.match(/^\s*\[([^\]]{6,})\]\s*/);
      if (m) sess = await loadSession(m[1]);
    }
    if (!sess) return res.json({ ok: true });

    // ذخیره در تاریخچه و ارسال به کلاینت
    const reply = { from: "admin", text, ts: Date.now() };
    await saveMsg(sess.sessionId, reply);
    io.to(sess.sessionId).emit("server_message", { from: "admin", text });

    res.json({ ok: true });
  } catch (e) {
    console.error("tg webhook error:", e.message);
    res.status(200).json({ ok: true });
  }
});

// ====== Start ======
server.listen(PORT, () => {
  console.log("Bridge listening on", PORT, "origins:", ORIGINS);
});
