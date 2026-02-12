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
  speechRec: null,
  handsFreeActive: false,
  micStream: null,
  audioCtx: null,
};

/* ── TTS via ElevenLabs (through gateway) ─────────────── */
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
    console.warn("ElevenLabs TTS failed, falling back to browser:", e);
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
      console.warn("ElevenLabs TTS failed, falling back to browser:", e);
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

async function api(path, opts={}) {
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

function setStatus(el, msg, isErr=false) {
  el.textContent = msg;
  el.style.color = isErr ? "#c30" : "#666";
}

function setHFStatus(msg) {
  const el = $("hfText");
  if (el) el.textContent = msg;
}

function setLiveTranscript(text) {
  const el = $("liveTranscript");
  if (el) el.textContent = text || "...";
}

function updateUI() {
  $("progress").textContent = state.sessionId ? `${state.idx+1} / ${state.total}` : "-";
  $("word").textContent = state.word || "-";
  $("prompt").textContent = state.prompt || "-";
  $("btnSpeakPrompt").disabled = !state.prompt;
  $("btnRecStart").disabled = !state.sessionId || state.handsFreeActive;
  $("btnLiveStart").disabled = !state.sessionId || !$("useLiveStt").checked;
  const hf = $("hfStatus");
  if (hf) hf.style.display = state.handsFreeActive ? "block" : "none";
}

/* -- VAD Recording ----------------------------------------- */
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
  $('btnRecStop').disabled = true;
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

      /* Live transcript via browser SpeechRecognition */
      let liveRec = null;
      let browserTranscript = '';
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (SR) {
        liveRec = new SR();
        liveRec.continuous = true;
        liveRec.interimResults = true;
        liveRec.lang = 'en-US';
        liveRec.onresult = (evt) => {
          let interim = '', final = '';
          for (let i = 0; i < evt.results.length; i++) {
            const r = evt.results[i];
            if (r.isFinal) final += r[0].transcript;
            else interim += r[0].transcript;
          }
          browserTranscript = (final + interim).trim();
          setLiveTranscript(browserTranscript || '...');
        };
        liveRec.onerror = () => {};
        try { liveRec.start(); } catch(e) {}
      }
      setLiveTranscript('Listening...');
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      mr.onstop = () => {
        stopped = true; if (cap) clearTimeout(cap);
        if (liveRec) try { liveRec.stop(); } catch(e) {}
        cleanupMic();
        resolve({ blob: new Blob(chunks, { type: 'audio/webm' }), transcript: browserTranscript });
      };
      mr.start();
      $('btnRecStop').disabled = false;
      cap = setTimeout(() => {
        if (!stopped && mr.state !== 'inactive') { stopped = true; mr.stop(); }
      }, 30000);
      (function tick() {
        if (stopped || mr.state === 'inactive') return;
        analyser.getByteTimeDomainData(buf);
        let s = 0;
        for (let i = 0; i < buf.length; i++) { const v=(buf[i]-128)/128; s+=v*v; }
        const rms = Math.sqrt(s / buf.length) * 100;
        if (rms > 3) { sp++; sil = 0; }
        else if (sp > 15) { sil++; }
        if (sil > 50 && sp > 15) {
          stopped = true; clearTimeout(cap);
          setHFStatus('Processing...');
          mr.stop(); return;
        }
        requestAnimationFrame(tick);
      })();
    } catch (e) { reject(e); }
  });
}

/* -- Hands-Free Loop ---------------------------------------- */
async function handsFreeLoop() {
  if (!state.handsFreeActive || !state.sessionId) return;
  setHFStatus("Speaking prompt...");
  await speakAndWait(state.prompt);
  if (!state.handsFreeActive) return;
  await new Promise(r => setTimeout(r, 600));
  if (!state.handsFreeActive) return;
  setHFStatus("Listening... say each letter slowly and clearly!");
  let recording;
  try { recording = await recordWithVAD(); } catch (e) {
    setHFStatus("Mic error: " + e.message);
    state.handsFreeActive = false; updateUI(); return;
  }
  if (!state.handsFreeActive) return;
  setHFStatus("Checking answer...");
  try {
    const fd = new FormData();
    fd.append("session_id", state.sessionId);
    fd.append("audio", recording.blob, "answer.webm");
    if (recording.transcript) fd.append("transcript", recording.transcript);
    const data = await api("/turn/answer", { method: "POST", body: fd });
    $("result").innerHTML = data.correct
      ? '<span class="ok">Correct!</span>'
      : '<span class="bad">Incorrect</span>';
    $("letters").textContent = data.letters || "";
    $("feedback").textContent = data.feedback_text || "";
    $("score").textContent = data.score_correct + " / " + data.score_total;
    $("transcript").value = "";
    setHFStatus("Speaking feedback...");
    await speakAndWait(data.feedback_text);
    if (data.done) {
      setHFStatus("All done! Great job!");
      state.handsFreeActive = false;
      state.prompt = "All done!"; state.word = "";
      updateUI(); return;
    }
    await ask(); updateUI();
    await new Promise(r => setTimeout(r, 800));
    handsFreeLoop();
  } catch (e) {
    setHFStatus("Error: " + e.message);
    state.handsFreeActive = false; updateUI();
  }
}

// 1) Extract words
$("btnExtract").onclick = async () => {
  const f = $("img").files?.[0];
  if (!f) return setStatus($("extractStatus"), "Pick an image first.", true);
  setStatus($("extractStatus"), "Extracting with Nemotron VL...");
  try {
    const fd = new FormData();
    fd.append("file", f);
    const data = await api("/extract_words", { method: "POST", body: fd });
    $("wordsBox").value = (data.words || []).join("\n");
    setStatus($("extractStatus"), `Extracted ${data.words.length} words.`);
  } catch (e) {
    setStatus($("extractStatus"), "Extraction failed: " + e.message, true);
  }
};

$("btnDemoList").onclick = () => {
  $("wordsBox").value = ["rhythm","necessary","accommodate","beautiful","calendar"].join("\n");
  setStatus($("extractStatus"), "Loaded demo list.");
};

// 2) Start session
$("btnStart").onclick = async () => {
  const words = wordsFromBox();
  if (!words.length) return alert("Add words first.");
  try {
    const data = await api("/session/start", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ words, student_name: $("studentName").value || "Student" })
    });
    state.sessionId = data.session_id;
    state.idx = data.idx;
    state.word = data.word;
    state.total = data.total;
    $("score").textContent = "0 / 0";
    $("result").textContent = "-";
    $("letters").textContent = "-";
    $("feedback").textContent = "-";
    await ask();
    if ($("handsFree").checked) {
      state.handsFreeActive = true;
      updateUI();
      handsFreeLoop();
    } else {
      speak(state.prompt);
    }
  } catch (e) {
    alert("Start failed: " + e.message);
  }
};

async function ask() {
  const fd = new FormData();
  fd.append("session_id", state.sessionId);
  const data = await api("/turn/ask", { method: "POST", body: fd });
  state.idx = data.idx;
  state.word = data.word;
  state.prompt = data.prompt_text;
  updateUI();
}

$("btnSpeakPrompt").onclick = () => speak(state.prompt);

// 3) Record audio (manual mode)
$("btnRecStart").onclick = async () => {
  if (state.handsFreeActive) return;
  state.chunks = [];
  state.audioBlob = null;

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    alert("Microphone access blocked!\n\n" +
          "Browsers require HTTPS for mic access on non-localhost.\n\n" +
          "Fix options:\n" +
          "1) Port-forward to localhost\n" +
          "2) Chrome flag: chrome://flags → 'Insecure origins treated as secure'");
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

// Optional live transcript (Chrome)
function initSpeechRec() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = "en-US";
  rec.onresult = (evt) => {
    let finalText = "";
    for (let i = evt.resultIndex; i < evt.results.length; i++) {
      const r = evt.results[i];
      if (r.isFinal) finalText += r[0].transcript + " ";
    }
    if (finalText.trim()) $("transcript").value = finalText.trim();
  };
  return rec;
}

$("useLiveStt").onchange = () => {
  const enabled = $("useLiveStt").checked;
  $("btnLiveStart").disabled = !enabled || !state.sessionId;
  $("btnLiveStop").disabled = true;
  if (enabled && !state.speechRec) state.speechRec = initSpeechRec();
  if (enabled && !state.speechRec) alert("Live transcript not supported in this browser. Use Chrome or upload audio.");
};

$("btnLiveStart").onclick = () => {
  if (!state.speechRec) return;
  state.speechRec.start();
  $("btnLiveStart").disabled = true;
  $("btnLiveStop").disabled = false;
};
$("btnLiveStop").onclick = () => {
  if (!state.speechRec) return;
  state.speechRec.stop();
  $("btnLiveStart").disabled = false;
  $("btnLiveStop").disabled = true;
};

// Submit answer
$("btnSubmit").onclick = async () => {
  try {
    const fd = new FormData();
    fd.append("session_id", state.sessionId);

    if (state.audioBlob) {
      fd.append("audio", state.audioBlob, "answer.webm");
    }
    const tx = $("transcript").value || "";
    if (tx.trim()) fd.append("transcript", tx.trim());

    const data = await api("/turn/answer", { method: "POST", body: fd });

    $("result").innerHTML = data.correct ? '<span class="ok">Correct</span>' : '<span class="bad">Incorrect</span>';
    $("letters").textContent = data.letters || "(none)";
    $("feedback").textContent = data.feedback_text || "";
    $("btnSpeakFeedback").disabled = !data.feedback_text;

    $("score").textContent = `${data.score_correct} / ${data.score_total}`;

    if (data.done) {
      state.prompt = "All done!";
      state.word = "";
      updateUI();
      speak(data.feedback_text);
      return;
    }

    await ask();
    speak(state.prompt);

  } catch (e) {
    alert("Submit failed: " + e.message + "\n\nIf ASR isn't configured, enable Live Transcript or type transcript manually.");
  }
};

$("btnSpeakFeedback").onclick = () => speak($("feedback").textContent);

$("btnHFStop").onclick = () => {
  state.handsFreeActive = false;
  cleanupMic();
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  window.speechSynthesis.cancel();
  setHFStatus("Stopped.");
  updateUI();
};

updateUI();
