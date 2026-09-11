import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { buildLivePayload, createApp, isValidSdp } from "../server.mjs";

const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function listen(app) {
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

describe("SDP validation", () => {
  it("accepts an SDP offer and rejects malformed input", () => {
    assert.equal(isValidSdp("v=0\r\no=- 1 2 IN IP4 127.0.0.1"), true);
    assert.equal(isValidSdp("not-sdp"), false);
    assert.equal(isValidSdp(null), false);
  });
});

describe("GPT-Live payload", () => {
  it("uses the dedicated Live protocol and keeps recordings disabled", () => {
    const payload = buildLivePayload("v=0\r\n", {});
    assert.equal(payload.session.model, "gpt-live-1");
    assert.equal(payload.session.store, false);
    assert.equal(payload.session.delegation.type, "responses");
    assert.equal(payload.transport.type, "webrtc");
  });
});

describe("POST /api/session", () => {
  it("rejects an unexpected origin before contacting OpenAI", async () => {
    let contacted = false;
    const app = createApp({
      apiKey: "test-key",
      allowedOrigins: new Set(["http://allowed.test"]),
      fetchImpl: async () => { contacted = true; },
    });
    const url = await listen(app);
    const response = await fetch(`${url}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://evil.test" },
      body: JSON.stringify({ sdp: "v=0\r\n" }),
    });
    assert.equal(response.status, 403);
    assert.equal(contacted, false);
  });

  it("keeps the API key server-side and returns only safe session data", async () => {
    let upstreamRequest;
    const app = createApp({
      apiKey: "server-secret",
      allowedOrigins: new Set(["http://allowed.test"]),
      fetchImpl: async (_url, init) => {
        upstreamRequest = init;
        return new Response(JSON.stringify({
          session: { id: "live_test", private_config: "not-for-browser" },
          transport: { type: "webrtc", sdp: "v=0\r\nanswer" },
        }), { status: 201, headers: { "Content-Type": "application/json" } });
      },
    });
    const url = await listen(app);
    const response = await fetch(`${url}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://allowed.test" },
      body: JSON.stringify({ sdp: "v=0\r\noffer" }),
    });
    const result = await response.json();
    assert.equal(response.status, 201);
    assert.equal(upstreamRequest.headers.Authorization, "Bearer server-secret");
    assert.deepEqual(result, {
      session: { id: "live_test" },
      transport: { type: "webrtc", sdp: "v=0\r\nanswer" },
    });
    assert.equal(JSON.stringify(result).includes("server-secret"), false);
    assert.equal(JSON.stringify(result).includes("private_config"), false);
  });

  it("explains when the server key is missing", async () => {
    const app = createApp({ apiKey: "", allowedOrigins: new Set(["http://allowed.test"]) });
    const url = await listen(app);
    const response = await fetch(`${url}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://allowed.test" },
      body: JSON.stringify({ sdp: "v=0\r\n" }),
    });
    assert.equal(response.status, 503);
  });
});

describe("POST /api/avatar/session", () => {
  it("creates a FULL LiveAvatar session without exposing the HeyGen API key", async () => {
    let upstreamRequest;
    const environment = {
      HEYGEN_AVATAR_ID: "avatar-test",
      HEYGEN_VOICE_ID: "voice-test",
      HEYGEN_CONTEXT_ID: "context-test",
      HEYGEN_SANDBOX: "true",
    };
    const app = createApp({
      apiKey: "openai-test",
      heygenApiKey: "heygen-secret",
      environment,
      allowedOrigins: new Set(["http://allowed.test"]),
      fetchImpl: async (_url, init) => {
        upstreamRequest = init;
        return new Response(JSON.stringify({
          data: { session_token: "short-lived-token", session_id: "avatar-session" },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });
    const url = await listen(app);
    const response = await fetch(`${url}/api/avatar/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://allowed.test" },
      body: "{}",
    });
    const result = await response.json();
    const body = JSON.parse(upstreamRequest.body);
    assert.equal(response.status, 201);
    assert.equal(upstreamRequest.headers["X-API-KEY"], "heygen-secret");
    assert.equal(body.mode, "FULL");
    assert.equal(body.avatar_persona.language, "ja");
    assert.deepEqual(result, {
      session_token: "short-lived-token",
      session_id: "avatar-session",
    });
    assert.equal(JSON.stringify(result).includes("heygen-secret"), false);
  });

  it("reports missing LiveAvatar configuration", async () => {
    const app = createApp({
      heygenApiKey: "",
      environment: {},
      allowedOrigins: new Set(["http://allowed.test"]),
    });
    const url = await listen(app);
    const response = await fetch(`${url}/api/avatar/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://allowed.test" },
      body: "{}",
    });
    assert.equal(response.status, 503);
  });
});
