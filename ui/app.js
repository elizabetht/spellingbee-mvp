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
  wrongWords: [],
  wordsCompleted: 0,
  originalWords: [],
  reviewTimeout: null,
};

const MIN_WORDS = 25;

/* ── Session Persistence (localStorage) ───────────────── */
const STORAGE_KEY = "spellingbee_session";

function saveProgress() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      originalWords: state.originalWords,
      wordsCompleted: state.wordsCompleted,
      wrongWords: state.wrongWords,
      remainingWords: state.originalWords.slice(state.wordsCompleted),
      savedAt: Date.now(),
    }));
  } catch (e) { /* ignore */ }
}

function loadSavedSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (Date.now() - saved.savedAt > 24 * 60 * 60 * 1000) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    if (saved.remainingWords && saved.remainingWords.length > 0) return saved;
    localStorage.removeItem(STORAGE_KEY);
    return null;
  } catch (e) { return null; }
}

function clearSavedSession() {
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
}

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

function showResult(correct, letters, feedbackText, word) {
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
  // Show the whole word (not letter-by-letter) so the child sees it clearly
  $("resultLetters").textContent = (word || letters || "").toUpperCase();
  // Don't show the spelled-out TTS feedback visually (it has "..." pauses for speech)
  $("feedback").textContent = "";
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
        // Wait for ~3 seconds of silence (180 frames at ~60fps) before stopping
        // This gives the child plenty of time to pause between letters
        if (sil > 180 && sp > 15) {
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
    return;
  }
  if (!state.handsFreeActive) return;

  // Check if the child asked for a definition or sentence usage
  const tx = (recording.transcript || "").toLowerCase();
  const sentencePattern = /\b(use it in a sentence|sentence)\b/;
  const defPattern = /\b(definition|meaning|what does it mean|what does that mean|what is that|what's that mean|explain)\b/;
  const wantsSentence = sentencePattern.test(tx);
  const wantsDef = defPattern.test(tx);
  if (wantsSentence || wantsDef) {
    setLiveTranscript("");
    setRing("idle", "\u{1F4D6}", wantsSentence ? "Sentence usage\u2026" : "Getting definition\u2026");
    try {
      const ctx = await api("/word/context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ word: state.word, session_id: state.sessionId }),
      });
      let defText;
      if (wantsSentence && ctx.sentence) {
        defText = ctx.sentence;
      } else if (ctx.definition) {
        defText = `${state.word} means ${ctx.definition}`;
      } else {
        defText = `Sorry, I don't have that for ${state.word} right now. Let's keep spelling!`;
      }
      await speakAndWait(defText);
    } catch (e) {
      await speakAndWait(`Sorry, I couldn't get the definition for ${state.word}.`);
    }
    // Re-prompt and listen again (don't count as an attempt)
    if (state.handsFreeActive) {
      await speakAndWait(`Now spell ${state.word}.`);
      await new Promise(r => setTimeout(r, 400));
      handsFreeLoop();
    }
    return;
  }

  // Detect off-topic questions/chat (not spelling letters)
  const chatPattern = /\b(what are|tell me|who is|where is|how do|can you|do you know|play|watch|netflix|movie|game|song|music|youtube|story|joke|weather|time|news|search|google|hey siri|alexa|okay google)\b/;
  const words = tx.trim().split(/\s+/);
  if (chatPattern.test(tx) || (words.length > 6 && !tx.split("").every(c => /[a-z\s]/.test(c)))) {
    await speakAndWait(`I can only help with spelling practice! Let's get back to it. Spell ${state.word}.`);
    if (state.handsFreeActive) {
      await new Promise(r => setTimeout(r, 400));
      handsFreeLoop();
    }
    return;
  }

  setRing("processing", "\u2699\uFE0F", "Checking\u2026");
  try {
    const fd = new FormData();
    fd.append("session_id", state.sessionId);
    fd.append("audio", recording.blob, "answer.webm");
    if (recording.transcript) fd.append("transcript", recording.transcript);
    const data = await api("/turn/answer", { method: "POST", body: fd });

    $("score").textContent = data.score_correct + " / " + data.score_total;
    showResult(data.correct, data.letters, data.feedback_text, state.word);
    setRing(data.correct ? "correct" : "wrong", data.correct ? "\u2705" : "\u274C", "");
    setLiveTranscript("");

    // Track wrong words (when word is skipped after max retries)
    if (!data.correct && data.attempts_for_word > 1) {
      // Word was skipped — add to wrong list if not already there
      if (data.word && !state.wrongWords.includes(data.word)) {
        state.wrongWords.push(data.word);
      }
    }
    if (data.correct || data.attempts_for_word > 1) {
      state.wordsCompleted++;
      saveProgress();
    }

    await speakAndWait(data.feedback_text);

    if (data.done) {
      // Merge backend wrong_words list (authoritative)
      if (data.wrong_words && data.wrong_words.length) {
        data.wrong_words.forEach(w => {
          if (!state.wrongWords.includes(w)) state.wrongWords.push(w);
        });
      }
      state.handsFreeActive = false;
      showDone();
      if (state.wrongWords.length > 0) {
        const msg = `Nice work! Now let's practice the ${state.wrongWords.length} word${state.wrongWords.length !== 1 ? "s" : ""} you missed.`;
        await speakAndWait(msg);
        // Auto-start review round after 2-second delay
        state.reviewTimeout = setTimeout(() => {
          state.reviewTimeout = null;
          startReviewRound();
        }, 2000);
      } else {
        await speakAndWait("You got everything right! Great job!");
      }
      return;
    }

    await ask();
    await new Promise(r => setTimeout(r, 800));
    handsFreeLoop();
  } catch (e) {
    setRing("wrong", "\u26A0\uFE0F", "Error: " + e.message);
    state.handsFreeActive = false;
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

// Resize image client-side to reduce VL processing time
function resizeImage(file, maxDim = 1536) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width <= maxDim && height <= maxDim) {
        resolve(file); // already small enough
        return;
      }
      const scale = maxDim / Math.max(width, height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.92);
    };
    img.src = URL.createObjectURL(file);
  });
}

// Extract words from image
$("btnExtract").onclick = async () => {
  const f = $("img").files?.[0];
  if (!f) {
    $("extractStatus").textContent = "Pick an image first.";
    $("extractStatus").classList.add("err");
    return;
  }
  $("extractStatus").classList.remove("err");
  $("btnExtract").disabled = true;
  const t0 = Date.now();
  const timer = setInterval(() => {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    $("extractStatus").textContent = `Extracting words\u2026 (${elapsed}s)`;
  }, 1000);
  $("extractStatus").textContent = "Extracting words\u2026";
  try {
    const resized = await resizeImage(f);
    const fd = new FormData();
    fd.append("file", resized, f.name);
    const data = await api("/extract_words", { method: "POST", body: fd });
    clearInterval(timer);
    $("wordsBox").value = (data.words || []).join("\n");
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    $("extractStatus").textContent = `Extracted ${data.words.length} words in ${elapsed}s.`;
    showWordEditor();
  } catch (e) {
    clearInterval(timer);
    $("extractStatus").textContent = "Extraction failed: " + e.message;
    $("extractStatus").classList.add("err");
  } finally {
    $("btnExtract").disabled = false;
  }
};

// Random word list via LLM
$("btnRandomList").onclick = async () => {
  $("btnRandomList").disabled = true;
  $("extractStatus").textContent = "Generating random words\u2026";
  $("extractStatus").classList.remove("err");
  try {
    const data = await api("/words/random", { method: "POST" });
    $("wordsBox").value = data.words.join("\n");
    $("extractStatus").textContent = `${data.words.length} random words loaded.`;
    showWordEditor();
  } catch (e) {
    $("extractStatus").textContent = "Failed to generate words: " + e.message;
    $("extractStatus").classList.add("err");
  } finally {
    $("btnRandomList").disabled = false;
  }
};

function showWordEditor() {
  $("wordEditor").classList.remove("hidden");
  // Keep words hidden by default so the child can't see them
  $("wordsBox").classList.add("hidden");
  updateWordCount();
}

$("btnToggleWords").onclick = () => {
  $("wordsBox").classList.toggle("hidden");
};

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
    state.wrongWords = [];
    state.wordsCompleted = 0;
    state.originalWords = [...words];
    saveProgress();
    $("score").textContent = "0 / 0";
    $("progress").textContent = `1 / ${state.total}`;
    await ask();
    showStage("stageSession");
    hideResult();
    // Auto-start hands-free immediately
    state.handsFreeActive = true;
    handsFreeLoop();
  } catch (e) {
    alert("Start failed: " + e.message);
  }
};

// Speak prompt
$("btnSpeakPrompt").onclick = () => speak(state.prompt);

// End practice — with 25-word nudge
function stopEverything() {
  state.handsFreeActive = false;
  cleanupMic();
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  if (state.reviewTimeout) {
    clearTimeout(state.reviewTimeout);
    state.reviewTimeout = null;
  }
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}

function showDone() {
  stopEverything();
  $("finalScore").textContent = `${state.wordsCompleted} words practiced`;

  const wl = $("wrongWordsList");
  wl.innerHTML = "";
  wl.classList.add("hidden");
  if (state.wrongWords.length > 0) {
    $("wrongWordsMsg").textContent = `Nice work! Now let's practice the ${state.wrongWords.length} word${state.wrongWords.length !== 1 ? "s" : ""} you missed.`;
    $("reviewTransition").classList.remove("hidden");
    $("btnReviewWrong").classList.add("hidden");
  } else {
    $("wrongWordsMsg").textContent = "You got everything right! 🌟";
    $("reviewTransition").classList.add("hidden");
    $("btnReviewWrong").classList.add("hidden");
    clearSavedSession();
  }
  state.sessionId = null;
  showStage("stageDone");
}

$("btnEndPractice").onclick = () => {
  stopEverything();
  if (state.wordsCompleted < MIN_WORDS) {
    // Show nudge
    $("nudgeMsg").textContent = `You've practiced ${state.wordsCompleted} word${state.wordsCompleted !== 1 ? "s" : ""} so far \u2014 can you do ${MIN_WORDS}?`;
    $("nudgeOverlay").classList.remove("hidden");
  } else {
    showDone();
  }
};

$("btnKeepGoing").onclick = () => {
  $("nudgeOverlay").classList.add("hidden");
  state.handsFreeActive = true;
  handsFreeLoop();
};

$("btnEndAnyway").onclick = () => {
  $("nudgeOverlay").classList.add("hidden");
  showDone();
};

// Review wrong words from Done screen
$("btnReviewWrong").onclick = () => startReviewRound();

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
  stopEverything();
  state.sessionId = null;
  state.wrongWords = [];
  state.wordsCompleted = 0;
  showStage("stageSetup");
  showWordEditor();
};

// Auto-start a review round with wrong words
async function startReviewRound() {
  const reviewWords = [...state.wrongWords];
  if (reviewWords.length === 0) {
    // No words to review (possibly cancelled)
    return;
  }
  state.wrongWords = [];  // Reset for this round
  try {
    const data = await api("/session/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ words: reviewWords, student_name: "Student" }),
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
    state.handsFreeActive = true;
    handsFreeLoop();
  } catch (e) {
    $("wrongWordsMsg").textContent = "Couldn't start review: " + e.message;
  }
}

// Init
showStage("stageSetup");

// Check for a saved session to resume
(function checkResume() {
  const saved = loadSavedSession();
  if (!saved) return;
  const remaining = saved.remainingWords.length;
  const total = saved.originalWords.length;
  const done = total - remaining;
  $("resumeMsg").textContent = `You practiced ${done} of ${total} words last time. ${remaining} left!`;
  $("resumeBanner").classList.remove("hidden");

  $("btnResume").onclick = async () => {
    $("resumeBanner").classList.add("hidden");
    state.wordsCompleted = done;
    state.wrongWords = saved.wrongWords || [];
    state.originalWords = saved.originalWords;
    const words = saved.remainingWords;
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
      $("progress").textContent = `${done + 1} / ${total}`;
      await ask();
      showStage("stageSession");
      hideResult();
      state.handsFreeActive = true;
      handsFreeLoop();
    } catch (e) {
      alert("Resume failed: " + e.message);
    }
  };

  $("btnNewSession").onclick = () => {
    clearSavedSession();
    $("resumeBanner").classList.add("hidden");
  };
})();
