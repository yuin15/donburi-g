const elements = {
  start: document.querySelector("#start-button"),
  mute: document.querySelector("#mute-button"),
  muteLabel: document.querySelector("#mute-label"),
  clear: document.querySelector("#clear-button"),
  status: document.querySelector("#status"),
  badge: document.querySelector("#live-badge"),
  liveLabel: document.querySelector("#live-label"),
  captions: document.querySelector("#caption-list"),
  empty: document.querySelector("#empty-state"),
  audio: document.querySelector("#remote-audio"),
  character: document.querySelector("#character"),
  characterZone: document.querySelector(".character-zone"),
  avatarVideo: document.querySelector("#avatar-video"),
  avatarLoading: document.querySelector("#avatar-loading"),
};

const state = {
  peer: null,
  events: null,
  microphone: null,
  closeTimer: null,
  audioContext: null,
  animationFrame: null,
  ready: false,
  closing: false,
  muted: false,
  finalized: false,
  captions: [],
  seenEvents: new Set(),
  avatar: null,
  avatarReady: false,
  avatarFlushTimer: null,
  avatarSpoken: new Map(),
};

function setStatus(message, error = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle("error", error);
}

function setUi(mode) {
  const active = mode === "connecting" || mode === "connected" || mode === "closing";
  elements.start.disabled = mode === "connecting" || mode === "closing";
  elements.start.classList.toggle("active", active);
  elements.start.querySelector("span:last-child").textContent = active
    ? mode === "closing" ? "終了しています…" : "ライブを終了"
    : "ライブをはじめる";
  elements.mute.disabled = mode !== "connected";
  elements.badge.classList.toggle("on-air", mode === "connected");
  elements.liveLabel.textContent = mode === "connected" ? "ON AIR" : "OFF AIR";
}

function cleanup() {
  clearTimeout(state.closeTimer);
  clearTimeout(state.avatarFlushTimer);
  cancelAnimationFrame(state.animationFrame);
  state.microphone?.getTracks().forEach((track) => track.stop());
  state.events?.close();
  state.peer?.close();
  state.audioContext?.close().catch(() => {});
  elements.audio.srcObject = null;
  elements.avatarVideo.srcObject = null;
  elements.characterZone.classList.remove("avatar-ready");
  elements.avatarLoading.hidden = true;
  if (state.avatar) void state.avatar.stop().catch(() => {});
  elements.character.style.setProperty("--mouth-open", "0.08");
  elements.characterZone.classList.remove("speaking");
  Object.assign(state, {
    peer: null,
    events: null,
    microphone: null,
    closeTimer: null,
    audioContext: null,
    animationFrame: null,
    ready: false,
    closing: false,
    muted: false,
    avatar: null,
    avatarReady: false,
    avatarFlushTimer: null,
  });
  elements.muteLabel.textContent = "マイク ON";
  setUi("idle");
}

async function startLiveAvatar() {
  if (!window.LiveAvatarSDK?.LiveAvatarSession) {
    throw new Error("LiveAvatar SDKを読み込めませんでした。");
  }
  elements.avatarLoading.hidden = false;
  const response = await fetch("/api/avatar/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "LiveAvatarを開始できませんでした。");

  const { LiveAvatarSession, SessionEvent } = window.LiveAvatarSDK;
  const avatar = new LiveAvatarSession(result.session_token, {
    voiceChat: false,
    apiUrl: "https://api.liveavatar.com",
  });
  state.avatar = avatar;
  avatar.on(SessionEvent.SESSION_STREAM_READY, () => {
    avatar.attach(elements.avatarVideo);
    state.avatarReady = true;
    elements.avatarLoading.hidden = true;
    elements.characterZone.classList.add("avatar-ready");
  });
  await avatar.start();
}

function scheduleAvatarSpeech(caption) {
  clearTimeout(state.avatarFlushTimer);
  state.avatarFlushTimer = setTimeout(() => {
    if (!state.avatarReady || !state.avatar) return;
    const text = caption.fragments.map((fragment) => fragment.delta).join("");
    const spoken = state.avatarSpoken.get(caption.id) || "";
    const unsent = text.startsWith(spoken) ? text.slice(spoken.length) : text;
    if (!unsent.trim()) return;
    try {
      state.avatar.repeat(unsent);
      state.avatarSpoken.set(caption.id, text);
    } catch {
      setStatus("LiveAvatarへ発話を渡せませんでした。", true);
    }
  }, 900);
}

function startLipSync(stream) {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.72;
  context.createMediaStreamSource(stream).connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  state.audioContext = context;

  const draw = () => {
    analyser.getByteFrequencyData(data);
    const voiceBand = data.slice(2, 45);
    const average = voiceBand.reduce((sum, value) => sum + value, 0) / voiceBand.length;
    const amount = Math.min(1, Math.max(0.06, (average - 5) / 64));
    elements.character.style.setProperty("--mouth-open", amount.toFixed(2));
    elements.characterZone.classList.toggle("speaking", amount > 0.17);
    state.animationFrame = requestAnimationFrame(draw);
  };
  draw();
}

function renderCaptions() {
  elements.empty.hidden = state.captions.length > 0;
  elements.captions.querySelectorAll(".caption-row").forEach((row) => row.remove());

  for (const caption of state.captions) {
    const row = document.createElement("article");
    row.className = `caption-row ${caption.role}`;
    row.dataset.captionId = caption.id;
    const role = document.createElement("span");
    role.className = "caption-role";
    role.textContent = caption.role === "user" ? "YOU" : "DONBURI";
    const text = document.createElement("p");
    text.className = "caption-text";
    text.textContent = caption.fragments.map((fragment) => fragment.delta).join("");
    row.append(role, text);
    elements.captions.append(row);
  }
  elements.captions.scrollTop = elements.captions.scrollHeight;
}

function addTranscript(event) {
  if (
    !["session.input_transcript.delta", "session.output_transcript.delta"].includes(event.type) ||
    typeof event.delta !== "string" ||
    typeof event.start_ms !== "number" ||
    typeof event.end_ms !== "number"
  ) return;
  if (event.event_id && state.seenEvents.has(event.event_id)) return;
  if (event.event_id) state.seenEvents.add(event.event_id);

  const role = event.type === "session.input_transcript.delta" ? "user" : "assistant";
  let caption = state.captions.find((item) =>
    item.role === role && item.fragments.some((fragment) =>
      event.start_ms <= fragment.end_ms + 1500 && event.end_ms >= fragment.start_ms - 1500
    )
  );
  if (!caption) {
    caption = { id: crypto.randomUUID(), role, fragments: [] };
    state.captions.push(caption);
  }
  caption.fragments.push({ delta: event.delta, start_ms: event.start_ms, end_ms: event.end_ms });
  caption.fragments.sort((a, b) => a.start_ms - b.start_ms);
  renderCaptions();
  if (role === "assistant") scheduleAvatarSpeech(caption);
  if (role === "user" && state.avatarReady) {
    clearTimeout(state.avatarFlushTimer);
    try { state.avatar.interrupt(); } catch { /* Avatar may already be idle. */ }
  }
}

function handleEvent(event) {
  addTranscript(event);
  if (event.type === "session.started") {
    state.ready = true;
    setUi("connected");
    setStatus("接続しました。どんぶりちゃんに話しかけてください。");
  } else if (event.type === "session.closed") {
    state.finalized = true;
    const seconds = event.usage?.seconds;
    setStatus(`ライブを終了しました${typeof seconds === "number" ? `（${Math.ceil(seconds)}秒）` : ""}。`);
    cleanup();
  } else if (event.type === "error") {
    setStatus("GPT-Liveからエラーが返されました。", true);
  } else if (event.type === "response.event") {
    const type = event.event?.type;
    if (type === "response.created") setStatus("情報を調べています… 会話はそのまま続けられます。");
    if (["response.completed", "response.failed", "response.incomplete", "response.cancelled"].includes(type)) {
      setStatus(type === "response.completed" ? "調査が完了しました。" : "バックエンド処理を完了できませんでした。", type !== "response.completed");
    }
  }
}

async function waitForIce(peer) {
  if (peer.iceGatheringState === "complete") return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      peer.removeEventListener("icegatheringstatechange", check);
      reject(new Error("接続情報の収集がタイムアウトしました。"));
    }, 10_000);
    function check() {
      if (peer.iceGatheringState !== "complete") return;
      clearTimeout(timeout);
      peer.removeEventListener("icegatheringstatechange", check);
      resolve();
    }
    peer.addEventListener("icegatheringstatechange", check);
    check();
  });
}

async function startConversation() {
  state.finalized = false;
  setUi("connecting");
  setStatus("マイクとGPT-Liveを接続しています…");

  try {
    await startLiveAvatar();
    setStatus("LiveAvatarに接続しました。GPT-Liveを開始しています…");
    const peer = new RTCPeerConnection();
    state.peer = peer;
    peer.addEventListener("track", ({ track }) => {
      const stream = new MediaStream([track]);
      elements.audio.srcObject = stream;
      // GPT-Live audio drives the conversation timeline, but HeyGen produces
      // the user-facing voice to keep its video lip sync aligned.
      elements.audio.muted = true;
      startLipSync(stream);
    });
    peer.addEventListener("connectionstatechange", () => {
      if (["failed", "closed"].includes(peer.connectionState) && !state.finalized) {
        setStatus("接続が切れました。もう一度お試しください。", true);
        cleanup();
      }
    });

    state.microphone = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    state.microphone.getAudioTracks().forEach((track) => peer.addTrack(track, state.microphone));

    const events = peer.createDataChannel("oai-events");
    state.events = events;
    events.addEventListener("message", ({ data }) => {
      try { handleEvent(JSON.parse(data)); }
      catch { setStatus("受信イベントを読み取れませんでした。", true); }
    });
    events.addEventListener("close", () => {
      if (!state.finalized && !state.closing) {
        setStatus("最終利用情報を受け取る前に接続が閉じました。", true);
        cleanup();
      }
    });

    await peer.setLocalDescription(await peer.createOffer());
    await waitForIce(peer);
    const sdp = peer.localDescription?.sdp;
    if (!sdp) throw new Error("接続情報を作成できませんでした。");
    const response = await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sdp }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "GPT-Liveへ接続できませんでした。");
    await peer.setRemoteDescription({ type: "answer", sdp: result.transport.sdp });
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
    cleanup();
  }
}

function stopConversation() {
  if (!state.ready || state.events?.readyState !== "open") {
    cleanup();
    return;
  }
  state.closing = true;
  state.microphone?.getAudioTracks().forEach((track) => { track.enabled = false; });
  setUi("closing");
  setStatus("会話を安全に終了しています…");
  state.events.send(JSON.stringify({ type: "session.close" }));
  state.closeTimer = setTimeout(() => {
    setStatus("終了確認を受け取れませんでした。接続を閉じました。", true);
    cleanup();
  }, 15_000);
}

elements.start.addEventListener("click", () => {
  if (state.ready || state.closing) stopConversation();
  else void startConversation();
});

elements.mute.addEventListener("click", () => {
  if (!state.ready || state.events?.readyState !== "open") return;
  state.muted = !state.muted;
  const type = state.muted ? "session.input_audio.mute" : "session.input_audio.unmute";
  state.events.send(JSON.stringify({ type, event_id: crypto.randomUUID() }));
  state.microphone?.getAudioTracks().forEach((track) => { track.enabled = !state.muted; });
  elements.muteLabel.textContent = state.muted ? "マイク OFF" : "マイク ON";
  setStatus(state.muted ? "マイクをミュートしました。" : "マイクをオンにしました。");
});

elements.clear.addEventListener("click", () => {
  state.captions = [];
  state.seenEvents.clear();
  state.avatarSpoken.clear();
  renderCaptions();
});

window.addEventListener("pagehide", () => {
  if (state.ready && state.events?.readyState === "open") {
    state.events.send(JSON.stringify({ type: "session.close" }));
  }
  cleanup();
});
