io.on("connection", async (socket) => {
  // 1) فقط sessionId ادعاشده را قبول کن؛ نبود؟ یک‌بار بساز اما به کلاینت اعلام کن
  let claimed = socket.handshake.auth?.sessionId?.toString().trim()
             || socket.handshake.query?.sessionId?.toString().trim()
             || "";
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
    io.to(sessionId).emit("server_message", { from:"sys", text:"پیام شما ثبت شد ✅" });
  });
});
