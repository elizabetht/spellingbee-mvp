"""
Lightweight ASR (Automatic Speech Recognition) service for Spelling Bee.
Uses faster-whisper with the base.en model on CPU.
Accepts audio file uploads and returns transcription text.
"""

import os
import tempfile
import time

from fastapi import FastAPI, File, UploadFile
from faster_whisper import WhisperModel

APP_NAME = "spellingbee-asr"

# ── Config ──────────────────────────────────────────────
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "base.en")
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE = os.getenv("WHISPER_COMPUTE", "int8")

# ── Load model at startup ───────────────────────────────
print(f"Loading whisper model={WHISPER_MODEL} device={WHISPER_DEVICE} compute={WHISPER_COMPUTE}")
model = WhisperModel(WHISPER_MODEL, device=WHISPER_DEVICE, compute_type=WHISPER_COMPUTE)
print("Whisper model loaded.")

# ── FastAPI ─────────────────────────────────────────────
app = FastAPI(title=APP_NAME)


@app.get("/healthz")
def healthz():
    return {"ok": True, "model": WHISPER_MODEL, "device": WHISPER_DEVICE}


@app.post("/asr")
async def transcribe(file: UploadFile = File(...)):
    """
    Accept an audio file (webm, wav, mp3, etc.) and return transcription.
    faster-whisper uses ffmpeg internally so most audio formats work.
    """
    audio_bytes = await file.read()
    if not audio_bytes:
        return {"text": "", "error": "empty audio"}

    # Write to temp file (faster-whisper needs a file path)
    suffix = os.path.splitext(file.filename or "audio.webm")[1] or ".webm"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name

    try:
        t0 = time.time()
        segments, info = model.transcribe(
            tmp_path,
            language="en",
            beam_size=5,
            vad_filter=True,  # skip silence
            initial_prompt="The speaker is spelling a word by saying one letter at a time, like A, B, C, D, E, F, G.",
        )
        text = " ".join(seg.text.strip() for seg in segments).strip()
        elapsed = round(time.time() - t0, 2)
        print(f"ASR: {elapsed}s, lang={info.language}, text={text!r}")
    finally:
        os.unlink(tmp_path)

    return {"text": text}
