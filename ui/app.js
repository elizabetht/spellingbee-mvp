const $ = (id) => document.getElementById(id);

const state = {
  sessionId: null,
  idx: 0,
  total: 0,
  word: null,
  prompt: null,
  mediaRecorder: null,
  chunks: [],
  audioBlob: null,
  handsFreeActive: false,
  micStream: null,
  audioCtx: null,
};

/* ── TTS ──────────────────────────────────────────────── */
let currentAudio = null;

async function speak(text) {
  if (!text) return;
  try {
    if (currentAudio) { currentAudio.pause(); currentAudio = null; }
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(await res.text());
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    currentAudio = audio;
    audio.play();
  } catch (e) {
    console.warn("Server TTS failed, falling back to browser:", e);
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 0.9;
      window.speechSynthesis.speak(u);
    }
  }
}

function speakAndWait(text) {
  return new Promise(async (resolve) => {
    if (!text) return resolve();
    try {
      if (currentAudio) { currentAudio.pause(); currentAudio = null; }
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(await res.text());
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      currentAudio = audio;
      let done = false;
      const finish = () => { if (!done) { done = true; URL.revokeObjectURL(url); resolve(); } };
      audio.onended = finish;
      audio.onerror = finish;
      audio.play();
      setTimeout(finish, Math.max(text.length * 150, 8000));
    } catch (e) {
      console.warn("Server TTS failed, falling back to browser:", e);
      if ("speechSynthesis" in window) {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.rate = 0.9;
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        u.onend = finish;
        u.onerror = finish;
        window.speechSynthesis.speak(u);
        setTimeout(finish, Math.max(text.length * 120, 6000));
      } else { resolve(); }
    }
  });
}

/* ── API helper ───────────────────────────────────────── */
async function api(path, opts = {}) {
  const res = await fetch("/api" + path, opts);
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`${res.status}: ${t}`);
  }
  return res.json();
}

function wordsFromBox() {
  const raw = $("wordsBox").value || "";
  return raw.split(/[\n,]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
}

/* ── Stage management ─────────────────────────────────── */
function showStage(id) {
  ["stageSetup", "stageSession", "stageDone"].forEach(s => {
    const el = $(s);
    if (s === id) {
      el.classList.remove("hidden");
      el.classList.add("fade-in");
    } else {
      el.classList.add("hidden");
    }
  });
  $("scoreBar").classList.toggle("hidden", id === "stageSetup");
}

function updateScore() {
  // score text is set directly from API responses
}

function setRing(cls, emoji, status) {
  const ring = $("listenRing");
  ring.className = "listen-ring " + cls;
  $("listenIcon").textContent = emoji || "\u{1F3A4}";
  $("listenStatus").textContent = status || "";
}

function setLiveTranscript(text) {
  $("liveTranscript").textContent = text || "";
}

function showResult(correct, letters, feedbackText) {
  const area = $("resultArea");
  area.classList.remove("hidden");
  const badge = $("resultBadge");
  if (correct) {
    badge.textContent = "\u2705 Correct!";
    badge.className = "result-badge ok";
  } else {
    badge.textContent = "\u274C Incorrect";
    badge.className = "result-badge bad";
  }
  $("resultLetters").textContent = letters ? letters.split("").join(" ").toUpperCase() : "";
  $("feedback").textContent = feedbackText || "";
}

function hideResult() {
  $("resultArea").classList.add("hidden");
}

/* ── Mic / VAD ────────────────────────────────────────── */
function cleanupMic() {
  if (state.micStream) {
    state.micStream.getTracks().forEach(t => t.stop());
    state.micStream = null;
  }
  if (state.audioCtx) {
    state.audioCtx.close().catch(() => {});
    state.audioCtx = null;
  }
  state.mediaRecorder = null;
}

function recordWithVAD() {
  return new Promise(async (resolve, reject) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      state.micStream = stream;
      const actx = new (window.AudioContext || window.webkitAudioContext)();
      state.audioCtx = actx;
      const analyser = actx.createAnalyser();
      analyser.fftSize = 2048;
      actx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      let sil = 0, sp = 0, stopped = false, cap;
      const chunks = [];
      const mr = new MediaRecorder(stream);
      state.mediaRecorder = mr;

      let liveRec = null;
      let browserTranscript = "";
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (SR) {
        liveRec = new SR();
        liveRec.continuous = true;
        liveRec.interimResults = true;
        liveRec.lang = "en-US";
        liveRec.onresult = (evt) => {
          let interim = "", final = "";
          for (let i = 0; i < evt.results.length; i++) {
            const r = evt.results[i];
            if (r.isFinal) final += r[0].transcript;
            else interim += r[0].transcript;
          }
          browserTranscript = (final + interim).trim();
          setLiveTranscript(browserTranscript || "\u2026");
        };
        liveRec.onerror = () => {};
        try { liveRec.start(); } catch (e) {}
      }
      setLiveTranscript("Listening\u2026");

      mr.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      mr.onstop = () => {
        stopped = true;
        if (cap) clearTimeout(cap);
        if (liveRec) try { liveRec.stop(); } catch (e) {}
        cleanupMic();
        resolve({ blob: new Blob(chunks, { type: "audio/webm" }), transcript: browserTranscript });
      };
      mr.start();

      cap = setTimeout(() => {
        if (!stopped && mr.state !== "inactive") { stopped = true; mr.stop(); }
      }, 30000);

      (function tick() {
        if (stopped || mr.state === "inactive") return;
        analyser.getByteTimeDomainData(buf);
        let s = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; s += v * v; }
        const rms = Math.sqrt(s / buf.length) * 100;
        if (rms > 3) { sp++; sil = 0; }
        else if (sp > 15) { sil++; }
        if (sil > 50 && sp > 15) {
          stopped = true; clearTimeout(cap);
          setRing("processing", "\u2699\uFE0F", "Processing\u2026");
          mr.stop();
          return;
        }
        requestAnimationFrame(tick);
      })();
    } catch (e) { reject(e); }
  });
}

/* ── Hands-Free Loop ──────────────────────────────────── */
async function handsFreeLoop() {
  if (!state.handsFreeActive || !state.sessionId) return;

  hideResult();
  setRing("idle", "\u{1F50A}", "Listen to the word\u2026");
  await speakAndWait(state.prompt);
  if (!state.handsFreeActive) return;

  await new Promise(r => setTimeout(r, 600));
  if (!state.handsFreeActive) return;

  setRing("listening", "\u{1F3A4}", "Say each letter slowly\u2026");
  let recording;
  try {
    recording = await recordWithVAD();
  } catch (e) {
    setRing("wrong", "\u26A0\uFE0F", "Mic error: " + e.message);
    state.handsFreeActive = false;
    $("btnHandsFree").classList.remove("hidden");
    $("btnHFStop").classList.add("hidden");
    return;
  }
  if (!state.handsFreeActive) return;

  setRing("processing", "\u2699\uFE0F", "Checking\u2026");
  try {
    const fd = new FormData();
    fd.append("session_id", state.sessionId);
    fd.append("audio", recording.blob, "answer.webm");
    if (recording.transcript) fd.append("transcript", recording.transcript);
    const data = await api("/turn/answer", { method: "POST", body: fd });

    $("score").textContent = data.score_correct + " / " + data.score_total;
    showResult(data.correct, data.letters, data.feedback_text);
    setRing(data.correct ? "correct" : "wrong", data.correct ? "\u2705" : "\u274C", "");
    setLiveTranscript("");

    await speakAndWait(data.feedback_text);

    if (data.done) {
      $("finalScore").textContent = `${data.score_correct} out of ${data.score_total} correct`;
      state.handsFreeActive = false;
      showStage("stageDone");
      return;
    }

    await ask();
    await new Promise(r => setTimeout(r, 800));
    handsFreeLoop();
  } catch (e) {
    setRing("wrong", "\u26A0\uFE0F", "Error: " + e.message);
    state.handsFreeActive = false;
    $("btnHandsFree").classList.remove("hidden");
    $("btnHFStop").classList.add("hidden");
  }
}

/* ── API: ask for next word ───────────────────────────── */
async function ask() {
  const fd = new FormData();
  fd.append("session_id", state.sessionId);
  const data = await api("/turn/ask", { method: "POST", body: fd });
  state.idx = data.idx;
  state.word = data.word;
  state.prompt = data.prompt_text;
  $("progress").textContent = `${state.idx + 1} / ${state.total}`;
}

/* ── Event Handlers ───────────────────────────────────── */

// Extract words from image
$("btnExtract").onclick = async () => {
  const f = $("img").files?.[0];
  if (!f) {
    $("extractStatus").textContent = "Pick an image first.";
    $("extractStatus").classList.add("err");
    return;
  }
  $("extractStatus").textContent = "Extracting words\u2026";
  $("extractStatus").classList.remove("err");
  try {
    const fd = new FormData();
    fd.append("file", f);
    const data = await api("/extract_words", { method: "POST", body: fd });
    $("wordsBox").value = (data.words || []).join("\n");
    $("extractStatus").textContent = `Extracted ${data.words.length} words.`;
    showWordEditor();
  } catch (e) {
    $("extractStatus").textContent = "Extraction failed: " + e.message;
    $("extractStatus").classList.add("err");
  }
};

// Demo list
$("btnDemoList").onclick = () => {
  $("wordsBox").value = ["rhythm", "necessary", "accommodate", "beautiful", "calendar"].join("\n");
  $("extractStatus").textContent = "Demo list loaded.";
  showWordEditor();
};

function showWordEditor() {
  $("wordEditor").classList.remove("hidden");
  updateWordCount();
}

function updateWordCount() {
  const words = wordsFromBox();
  $("wordCount").textContent = words.length > 0 ? `${words.length} word${words.length !== 1 ? "s" : ""} ready` : "";
  $("btnStartSession").disabled = words.length === 0;
}

$("wordsBox").addEventListener("input", updateWordCount);

// Start session
$("btnStartSession").onclick = async () => {
  const words = wordsFromBox();
  if (!words.length) return;
  try {
    const data = await api("/session/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ words, student_name: "Student" }),
    });
    state.sessionId = data.session_id;
    state.idx = data.idx;
    state.word = data.word;
    state.total = data.total;
    $("score").textContent = "0 / 0";
    $("progress").textContent = `1 / ${state.total}`;
    await ask();
    showStage("stageSession");
    hideResult();
    setRing("idle", "\u{1F3A4}", "Tap \u25B6 to begin");
    setLiveTranscript("");
  } catch (e) {
    alert("Start failed: " + e.message);
  }
};

// Speak prompt
$("btnSpeakPrompt").onclick = () => speak(state.prompt);

// Hands-free start
$("btnHandsFree").onclick = () => {
  state.handsFreeActive = true;
  $("btnHandsFree").classList.add("hidden");
  $("btnHFStop").classList.remove("hidden");
  handsFreeLoop();
};

// Hands-free stop
$("btnHFStop").onclick = () => {
  state.handsFreeActive = false;
  cleanupMic();
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  setRing("idle", "\u{1F3A4}", "Stopped");
  setLiveTranscript("");
  $("btnHandsFree").classList.remove("hidden");
  $("btnHFStop").classList.add("hidden");
};

// Manual record
$("btnRecStart").onclick = async () => {
  if (state.handsFreeActive) return;
  state.chunks = [];
  state.audioBlob = null;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    alert("Microphone access blocked. Use HTTPS or localhost.");
    return;
  }
  const mr = new MediaRecorder(stream);
  state.mediaRecorder = mr;
  mr.ondataavailable = (e) => { if (e.data.size > 0) state.chunks.push(e.data); };
  mr.onstop = () => {
    state.audioBlob = new Blob(state.chunks, { type: "audio/webm" });
    stream.getTracks().forEach(t => t.stop());
    $("btnSubmit").disabled = false;
    $("btnRecStart").disabled = false;
    $("btnRecStop").disabled = true;
  };
  mr.start();
  $("btnRecStart").disabled = true;
  $("btnRecStop").disabled = false;
  $("btnSubmit").disabled = true;
};

$("btnRecStop").onclick = () => {
  if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") {
    state.mediaRecorder.stop();
  }
};

// Manual submit
$("btnSubmit").onclick = async () => {
  try {
    const fd = new FormData();
    fd.append("session_id", state.sessionId);
    if (state.audioBlob) fd.append("audio", state.audioBlob, "answer.webm");
    const tx = $("transcript").value || "";
    if (tx.trim()) fd.append("transcript", tx.trim());

    const data = await api("/turn/answer", { method: "POST", body: fd });
    $("score").textContent = `${data.score_correct} / ${data.score_total}`;
    showResult(data.correct, data.letters, data.feedback_text);

    if (data.done) {
      $("finalScore").textContent = `${data.score_correct} out of ${data.score_total} correct`;
      showStage("stageDone");
      speak(data.feedback_text);
      return;
    }
    await ask();
    speak(state.prompt);
  } catch (e) {
    alert("Submit failed: " + e.message);
  }
};

// Speak feedback
$("btnSpeakFeedback").onclick = () => speak($("feedback").textContent);

// Change words (go back to setup)
$("btnEditList").onclick = () => {
  state.sessionId = null;
  state.handsFreeActive = false;
  cleanupMic();
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  showStage("stageSetup");
  showWordEditor();
};

// Restart (from done screen)
$("btnRestart").onclick = () => {
  state.sessionId = null;
  state.handsFreeActive = false;
  showStage("stageSetup");
  showWordEditor();
};

// Init
showStage("stageSetup");
