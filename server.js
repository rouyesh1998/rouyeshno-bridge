import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import { Telegraf } from "telegraf";
import { nanoid } from "nanoid";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID);
const PORT = process.env.PORT || 3000;
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";

if (!TELEGRAM_BOT_TOKEN || !ADMIN_CHAT_ID) {
  console.error("❌ توکن یا چت آیدی تنظیم نشده");
  process.exit(1);
}

const app = express();
app.use(cors({ origin: ALLOW_ORIGIN === "*" ? true : [ALLOW_ORIGIN] }));
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: ALLOW_ORIGIN } });

const sessions = new Map();
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

bot.start((ctx) => {
  if (ctx.chat.id !== ADMIN_CHAT_ID) return;
  ctx.reply("پل تلگرام ↔ سایت فعال شد.\nبرای پاسخ: /r SESSION پیام");
});

bot.hears(/^\/r\s+(\w+)\s+([\s\S]+)/, async (ctx) => {
  if (ctx.chat.id !== ADMIN_CHAT_ID) return;
  const sessionId = ctx.match[1];
  const text = ctx.match[2].trim();
  const entry = sessions.get(sessionId);
  if (!entry) return ctx.reply(`❌ جلسه پیدا نشد: ${sessionId}`);
  entry.socket.emit("server_message", { from: "admin", text });
  await ctx.reply(`✅ ارسال شد به ${sessionId}`);
});

bot.launch().then(() => console.log("🤖 Bot started"));

io.on("connection", (socket) => {
  const sessionId = nanoid(6);
  sessions.set(sessionId, { socket, createdAt: Date.now() });

  socket.emit("session", { sessionId });
  bot.telegram.sendMessage(
    ADMIN_CHAT_ID,
    `🟢 اتصال جدید\nSession: ${sessionId}\nبرای پاسخ: /r ${sessionId} پیام`
  );

  socket.on("client_message", async ({ text, name, phone }) => {
    const msg =
      `💬 پیام جدید\nSession: ${sessionId}\n` +
      (name ? `نام: ${name}\n` : ``) +
      (phone ? `شماره: ${phone}\n` : ``) +
      `متن:\n${text}`;
    await bot.telegram.sendMessage(ADMIN_CHAT_ID, msg);
    socket.emit("server_message", { from: "bot", text: "پیام شما ارسال شد ✅" });
  });

  socket.on("disconnect", () => {
    sessions.delete(sessionId);
    bot.telegram.sendMessage(ADMIN_CHAT_ID, `🔴 قطع ارتباط\nSession: ${sessionId}`);
  });
});

app.get("/", (req, res) => res.send("Bridge is running..."));
httpServer.listen(PORT, () => console.log("🚀 Server on port", PORT));
