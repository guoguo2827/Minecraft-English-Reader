"use strict";

const express = require("express");
const { accessError } = require("./world-service");
const C = require("./world-content");
const { createWindowCounter, rateLimitMiddleware } = require("./rate-limit");

module.exports = function worldRouter({ service, speakingItems, ensureTtsAudio, getTencentVoiceType, limitTtsUser, limitTtsIp, ttsGenerationCounter }) {
  const router = express.Router();
  const phrases = speakingItems.filter(p => C.PHRASE_IDS.includes(p.id));
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    const denied = accessError(req.user);
    if (denied) return res.status(403).json(denied);
    return next();
  });
  const wrap = (handler) => (req, res, next) => {
    try { return res.json(handler(req)); } catch (error) {
      if (!error.code) return next(error);
      return res.status(error.status || 400).json({ code: error.code, error: error.message });
    }
  };
  router.get("/bootstrap", wrap(req => ({ ...service.bootstrap(req.user.id), phrases })));
  router.use(rateLimitMiddleware({
    counter: createWindowCounter({ windowMs: 60000, max: 240 }),
    key: req => `world:${req.user.id}`, code: "WORLD_BUSY", message: "操作有点快，请稍后再试"
  }));
  router.post("/actions", wrap(req => service.act(req.user.id, req.body)));
  router.post("/learning/next", wrap(req => service.nextQuestion(req.user.id, req.body.wordId)));
  router.post("/learning/answer", wrap(req => service.answer(req.user.id, req.body)));
  router.get("/audio/:id", limitTtsUser, limitTtsIp, async (req, res) => {
    const word = C.WORDS.find(w => `word-${w.id}` === req.params.id);
    const phrase = phrases.find(p => `phrase-${p.id}` === req.params.id);
    const text = word?.word || phrase?.english;
    if (!text) return res.status(404).json({ code: "WORLD_AUDIO_NOT_FOUND", error: "没有找到这段营地语音" });
    try {
      const audio = await ensureTtsAudio(text, {
        lang: "en",
        beforeGenerate: () => {
          const result = ttsGenerationCounter.consume(`tts-generate:${req.user.id}`);
          if (!result.allowed) {
            const error = new Error("语音正在准备中，请稍后再试");
            Object.assign(error, { status: 429, retryAfter: result.retryAfter }); throw error;
          }
        }
      });
      res.set("Content-Type", audio.contentType);
      res.set("Cache-Control", "private, max-age=31536000, immutable");
      res.set("X-TTS-Voice-Type", String(getTencentVoiceType("en") ?? "default"));
      return res.sendFile(audio.filePath);
    } catch (error) {
      if (error.retryAfter) res.set("Retry-After", String(error.retryAfter));
      return res.status(error.status === 429 ? 429 : 503).json({ code: "TTS_UNAVAILABLE", error: "标准音暂时无法播放，可以查看字幕或点击重试" });
    }
  });
  router.use((req, res) => res.status(404).json({ code: "WORLD_ROUTE_NOT_FOUND", error: "没有找到这个营地操作" }));
  router.use((error, req, res, next) => {
    console.error("World request failed:", error.message);
    if (res.headersSent) return next(error);
    return res.status(500).json({ code: "WORLD_SAVE_FAILED", error: "营地暂时无法保存，请稍后重试" });
  });
  return router;
};
