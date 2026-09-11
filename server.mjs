import express from "express";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_PORT = 3000;
const LIVE_ENDPOINT = "https://api.openai.com/v1/live/sessions";
const LIVEAVATAR_ENDPOINT = "https://api.liveavatar.com/v1/sessions/token";

export function getAllowedOrigins(port = DEFAULT_PORT, configured = "") {
  const explicit = configured
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return new Set([
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    ...explicit,
  ]);
}

export function isValidSdp(value) {
  return (
    typeof value === "string" &&
    value.length <= 65_536 &&
    value.trimStart().startsWith("v=0")
  );
}

export function buildLivePayload(sdp, environment = process.env) {
  return {
    session: {
      model: environment.OPENAI_LIVE_MODEL || "gpt-live-1",
      instructions:
        environment.LIVE_CHARACTER_PROMPT ||
        [
          "あなたは『どんぶりちゃん』という明るく親しみやすいAI-Tuberです。",
          "基本的に日本語で、配信で聞きやすい短い文を使って自然に話してください。",
          "最新情報、調査、複雑な推論、外部の作業が必要なときはバックエンドへ委譲してください。",
          "知らないことを知っているふりはしないでください。",
        ].join("\n"),
      audio: {
        output: { voice: environment.OPENAI_LIVE_VOICE || "marin" },
      },
      store: false,
      delegation: {
        type: "responses",
        responses: {
          model: environment.OPENAI_BACKEND_MODEL || "gpt-5.6-terra",
          instructions:
            "日本語の音声会話向けに、根拠のある簡潔な結果を返してください。必要ならWeb検索を使ってください。",
          tools: [{ type: "web_search" }],
          tool_choice: "auto",
        },
      },
    },
    transport: { type: "webrtc", sdp },
  };
}

export function createApp({
  apiKey = process.env.OPENAI_API_KEY,
  heygenApiKey = process.env.HEYGEN_API_KEY,
  port = DEFAULT_PORT,
  allowedOrigins = getAllowedOrigins(port, process.env.APP_ORIGINS),
  fetchImpl = globalThis.fetch,
  environment = process.env,
} = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));

  app.post("/api/session", async (request, response) => {
    response.set("Cache-Control", "no-store");

    if (!allowedOrigins.has(request.headers.origin)) {
      return response.status(403).json({ error: "Unexpected request origin" });
    }
    if (!isValidSdp(request.body?.sdp)) {
      return response.status(400).json({ error: "A valid SDP offer is required" });
    }
    if (!apiKey) {
      return response
        .status(503)
        .json({ error: "OPENAI_API_KEY is not configured on the server" });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);

    try {
      const upstream = await fetchImpl(LIVE_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildLivePayload(request.body.sdp, environment)),
        signal: controller.signal,
      });

      if (!upstream.ok) {
        console.error("GPT-Live session creation failed", {
          status: upstream.status,
          requestId: upstream.headers.get("x-request-id"),
        });
        return response
          .status(upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502)
          .json({ error: "GPT-Live session creation failed" });
      }

      const result = await upstream.json();
      if (
        typeof result.session?.id !== "string" ||
        !isValidSdp(result.transport?.sdp)
      ) {
        return response
          .status(502)
          .json({ error: "Invalid response from GPT-Live" });
      }

      return response.status(201).json({
        session: { id: result.session.id },
        transport: { type: "webrtc", sdp: result.transport.sdp },
      });
    } catch (error) {
      const timedOut = error?.name === "AbortError";
      console.error("GPT-Live connection error", timedOut ? "timeout" : error?.message);
      return response
        .status(timedOut ? 504 : 502)
        .json({ error: timedOut ? "GPT-Live request timed out" : "GPT-Live connection failed" });
    } finally {
      clearTimeout(timeout);
    }
  });

  app.post("/api/avatar/session", async (request, response) => {
    response.set("Cache-Control", "no-store");

    if (!allowedOrigins.has(request.headers.origin)) {
      return response.status(403).json({ error: "Unexpected request origin" });
    }

    const avatarId = environment.HEYGEN_AVATAR_ID;
    const voiceId = environment.HEYGEN_VOICE_ID;
    const contextId = environment.HEYGEN_CONTEXT_ID;
    if (!heygenApiKey || !avatarId || !voiceId || !contextId) {
      return response.status(503).json({
        error:
          "HEYGEN_API_KEY, HEYGEN_AVATAR_ID, HEYGEN_VOICE_ID and HEYGEN_CONTEXT_ID are required",
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const upstream = await fetchImpl(LIVEAVATAR_ENDPOINT, {
        method: "POST",
        headers: {
          "X-API-KEY": heygenApiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          mode: "FULL",
          avatar_id: avatarId,
          avatar_persona: {
            voice_id: voiceId,
            context_id: contextId,
            language: "ja",
          },
          is_sandbox: environment.HEYGEN_SANDBOX !== "false",
        }),
        signal: controller.signal,
      });

      if (!upstream.ok) {
        console.error("LiveAvatar session creation failed", {
          status: upstream.status,
          requestId: upstream.headers.get("x-request-id"),
        });
        return response
          .status(upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502)
          .json({ error: "LiveAvatar session creation failed" });
      }

      const result = await upstream.json();
      const token = result.data?.session_token;
      const sessionId = result.data?.session_id;
      if (typeof token !== "string" || typeof sessionId !== "string") {
        return response
          .status(502)
          .json({ error: "Invalid response from LiveAvatar" });
      }
      return response.status(201).json({ session_token: token, session_id: sessionId });
    } catch (error) {
      const timedOut = error?.name === "AbortError";
      console.error("LiveAvatar connection error", timedOut ? "timeout" : error?.message);
      return response
        .status(timedOut ? 504 : 502)
        .json({ error: timedOut ? "LiveAvatar request timed out" : "LiveAvatar connection failed" });
    } finally {
      clearTimeout(timeout);
    }
  });

  app.get("/vendor/liveavatar.js", (_request, response) => {
    response.set("Cache-Control", "public, max-age=86400");
    response.sendFile(
      resolve("node_modules/@heygen/liveavatar-web-sdk/dist/index.umd.js"),
    );
  });

  app.use(express.static("public", { extensions: ["html"] }));
  return app;
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const port = Number.parseInt(process.env.PORT || String(DEFAULT_PORT), 10);
  createApp({ port }).listen(port, "127.0.0.1", () => {
    console.log(`Donburi GPT-Live demo: http://localhost:${port}`);
  });
}
