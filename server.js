const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const TelegramBot = require("node-telegram-bot-api");
const Redis = require("ioredis");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.ALLOW_ORIGIN || "*",
    methods: ["GET", "POST"],
  },
});

// متغیرهای محیطی
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const REDIS_URL = process.env.REDIS_URL;

// اتصال به ردیـس برای ذخیره پیام‌ها
const redis = new Redis(REDIS_URL);

// ربات تلگرام
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// اندپوینت هلت‌چک برای Render
app.get("/healthz", (req, res) => {
  res.send("OK");
});

// وقتی کاربر وصل میشه
io.on("connection", async (socket) => {
  console.log("یک کاربر وصل شد:", socket.id);

  // بررسی وجود sessionId
  let sessionId = socket.handshake.auth.sessionId;
  if (!sessionId) {
    sessionId = socket.id;
  }
  socket.sessionId = sessionId;

  // پیام خوش‌آمد
  socket.emit("session", { sessionId });

  // بازیابی پیام‌های قبلی از Redis
  const prevMessages = await redis.lrange(`chat:${sessionId}`, 0, -1);
  prevMessages.forEach((msg) => {
    const data = JSON.parse(msg);
    socket.emit("server_message", data);
  });

  // دریافت پیام از کاربر
  socket.on("client_message", async (msg) => {
    const data = {
      from: "user",
      text: msg.text,
      name: msg.name || "",
      phone: msg.phone || "",
      time: Date.now(),
    };

    // ذخیره در Redis
    await redis.rpush(`chat:${sessionId}`, JSON.stringify(data));

    // فرستادن به ادمین تلگرام
    bot.sendMessage(
      ADMIN_CHAT_ID,
      `پیام جدید از کاربر:\n\nنام: ${msg.name || "نامشخص"}\nشماره: ${
        msg.phone || "نداده"
      }\nپیام: ${msg.text}`
    );
  });
});

// وقتی ادمین در تلگرام پیام میفرسته → ارسال به وب
bot.on("message", async (msg) => {
  if (msg.chat.id.toString() !== ADMIN_CHAT_ID) return;

  const text = msg.text;
  const sessionId = msg.reply_to_message
    ? msg.reply_to_message.text.split(" ")[2]
    : null;

  // اگر کاربر انتخاب نشده باشه
  if (!sessionId) {
    bot.sendMessage(ADMIN_CHAT_ID, "⚠️ برای پاسخ به کاربر، روی پیامش ریپلای کن.");
    return;
  }

  const data = {
    from: "admin",
    text,
    time: Date.now(),
  };

  // ذخیره در Redis
  await redis.rpush(`chat:${sessionId}`, JSON.stringify(data));

  // فرستادن به کاربر در وب
  io.to(sessionId).emit("server_message", data);
});

// شروع سرور
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`سرور روی پورت ${PORT} بالا اومد ✅`);
});
