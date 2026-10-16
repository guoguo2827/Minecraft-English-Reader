"use strict";
const express = require("express");
const { accessError } = require("./ket-service");
const { createWindowCounter, rateLimitMiddleware } = require("./rate-limit");
module.exports = function createKetRouter({ service, ensureTtsAudio, limitTtsUser, limitTtsIp, ttsGenerationCounter }) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    const denied = accessError(req.user);
    if (denied) return res.status(403).json(denied);
    if (req.method === "POST" && (!req.body || typeof req.body !== "object" || Array.isArray(req.body))) return res.status(400).json({ code: "INVALID_REQUEST", error: "请求格式不正确" });
    return next();
  });
  router.use(rateLimitMiddleware({ counter: createWindowCounter({ windowMs: 60000, max: 180 }),
    key: req => `ket:${req.user.id}`, code: "KET_BUSY", message: "操作有点快，请稍后重试" }));
  const wrap = handler => (req, res, next) => {
    try { return res.json(handler(req)); } catch (error) {
      if (!error.code) return next(error);
      return res.status(error.status || 400).json({ code: error.code, error: error.message });
    }
  };
  router.get("/catalog", wrap(req => service.catalog(req.user)));
  router.get("/report", wrap(req => service.report(req.user)));
  router.post("/settings", wrap(req => service.settings(req.user, req.body.dailyNew)));
  router.post("/sessions", wrap(req => service.start(req.user, req.body)));
  router.get("/sessions/:id", wrap(req => service.session(req.user, req.params.id)));
  router.post("/exposure", wrap(req => service.expose(req.user, req.body.wordId)));
  router.post("/answer", wrap(req => service.answer(req.user, req.body)));
  router.post("/next", wrap(req => service.next(req.user, req.body)));
  router.get("/audio/:id", limitTtsUser, limitTtsIp, async (req, res) => {
    try {
      const word = service.checkWord(req.user, req.params.id);
      if (req.query.part && !["word", "example"].includes(req.query.part)) return res.status(400).json({ error: "语音类型不正确" });
      const audio = await ensureTtsAudio(req.query.part === "example" ? word.example : word.word, {
        lang: "en", beforeGenerate: () => {
          const result = ttsGenerationCounter.consume(`tts-generate:${req.user.id}`);
          if (!result.allowed) throw Object.assign(new Error("语音请求较多，请稍后再试"), { status: 429 });
        }
      });
      res.set("Content-Type", audio.contentType);
      // Require a fresh permission check on each request, even after account expiry.
      res.set("Cache-Control", "private, no-store");
      return res.sendFile(audio.filePath);
    } catch (error) {
      return res.status(error.status || 503).json({ code: error.code || "TTS_UNAVAILABLE", error: error.code ? error.message : "标准音暂时无法播放，请点击重试" });
    }
  });
  router.use((error, req, res, next) => {
    console.error("KET request failed:", error.message);
    if (res.headersSent) return next(error);
    return res.status(500).json({ code: "KET_SAVE_FAILED", error: "暂时无法保存，请重试，不要关闭页面" });
  });
  return router;
};
