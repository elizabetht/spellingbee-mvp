import base64
import json
import os
import re
import time
import uuid
from typing import Dict, List, Optional, Tuple

import io
import wave

import requests
import riva.client
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel

APP_NAME = "spellingbee-gateway"

# --------- Config (via env) ----------
# vLLM OpenAI-compatible endpoints
VLLM_TEXT_BASE = os.getenv("VLLM_TEXT_BASE", "http://vllm-llama-31-8b:8000/v1")
VLLM_TEXT_MODEL = os.getenv("VLLM_TEXT_MODEL", "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16")

VLLM_VL_BASE = os.getenv("VLLM_VL_BASE", "http://vllm-nemotron-vl:5566/v1")
VLLM_VL_MODEL = os.getenv("VLLM_VL_MODEL", "nvidia/NVIDIA-Nemotron-Nano-12B-v2-VL-BF16")

# Optional: later plug in an ASR service here (Nemotron Speech or anything).
ASR_TIMEOUT_S = float(os.getenv("ASR_TIMEOUT_S", "30"))

# NVIDIA Magpie TTS (via Riva gRPC)
MAGPIE_TTS_URL = os.getenv("MAGPIE_TTS_URL", "grpc.nvcf.nvidia.com:443")
MAGPIE_TTS_FUNCTION_ID = os.getenv("MAGPIE_TTS_FUNCTION_ID", "877104f7-e885-42b9-8de8-f6e4c6303969")
MAGPIE_TTS_API_KEY = os.getenv("MAGPIE_TTS_API_KEY", "")
MAGPIE_TTS_VOICE = os.getenv("MAGPIE_TTS_VOICE", "Magpie-Multilingual.EN-US.Sofia")
MAGPIE_TTS_LANGUAGE = os.getenv("MAGPIE_TTS_LANGUAGE", "en-US")
MAGPIE_TTS_USE_SSL = os.getenv("MAGPIE_TTS_USE_SSL", "true").lower() == "true"

# ElevenLabs TTS (legacy fallback)
ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY", "")
ELEVENLABS_VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")
ELEVENLABS_MODEL_ID = os.getenv("ELEVENLABS_MODEL_ID", "eleven_flash_v2_5")

# Behavior
MAX_WORDS = int(os.getenv("MAX_WORDS", "200"))
RETRY_ON_WRONG = int(os.getenv("RETRY_ON_WRONG", "1"))

# ---------- In-memory session store (hackathon MVP) ----------
# session_id -> session dict
SESSIONS: Dict[str, dict] = {}

# ---------- FastAPI ----------
app = FastAPI(title=APP_NAME)

# If you use nginx reverse-proxy (recommended) you can turn CORS off.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------- Helpers ----------
_letter_re = re.compile(r"[a-z]")

NATO = {
    "alpha":"a","bravo":"b","charlie":"c","delta":"d","echo":"e","foxtrot":"f","golf":"g","hotel":"h",
    "india":"i","juliet":"j","kilo":"k","lima":"l","mike":"m","november":"n","oscar":"o","papa":"p",
    "quebec":"q","romeo":"r","sierra":"s","tango":"t","uniform":"u","victor":"v","whiskey":"w",
    "xray":"x","x-ray":"x","yankee":"y","zulu":"z",
}

LETTER_HOMOPHONES = {
    "ay":"a","a":"a","aye":"a","hey":"a",
    "bee":"b","be":"b","b":"b",
    "cee":"c","see":"c","sea":"c","c":"c",
    "dee":"d","d":"d",
    "ee":"e","e":"e","he":"e",
    "ef":"f","eff":"f","f":"f",
    "gee":"g","g":"g","ji":"g",
    "aitch":"h","h":"h","age":"h","each":"h","ach":"h",
    "i":"i","eye":"i",
    "jay":"j","j":"j",
    "kay":"k","k":"k","okay":"k",
    "el":"l","l":"l","ell":"l","elle":"l",
    "em":"m","m":"m",
    "en":"n","n":"n","and":"n","end":"n",
    "oh":"o","o":"o","owe":"o","ow":"o",
    "pee":"p","p":"p","pea":"p",
    "cue":"q","queue":"q","q":"q","kew":"q",
    "are":"r","r":"r","our":"r","ar":"r",
    "ess":"s","s":"s","es":"s",
    "tee":"t","t":"t","tea":"t",
    "you":"u","u":"u","yew":"u",
    "vee":"v","v":"v","ve":"v",
    "doubleyou":"w","double-u":"w","doubleu":"w","w":"w",
    "ex":"x","x":"x",
    "why":"y","y":"y","wye":"y",
    "zee":"z","zed":"z","z":"z",
}

def now_ms() -> int:
    return int(time.time() * 1000)

def normalize_word(w: str) -> str:
    w = (w or "").strip().lower()
    w = re.sub(r"[^a-z]", "", w)
    return w

def extract_json_object(text: str) -> Optional[dict]:
    """
    Try to find the first valid JSON object in a string.
    """
    if not text:
        return None
    text = text.strip()

    # Fast path
    if text.startswith("{") and text.endswith("}"):
        try:
            return json.loads(text)
        except Exception:
            pass

    # Heuristic: find first {...}
    start = text.find("{")
    while start != -1:
        depth = 0
        for i in range(start, len(text)):
            if text[i] == "{":
                depth += 1
            elif text[i] == "}":
                depth -= 1
                if depth == 0:
                    snippet = text[start : i + 1]
                    try:
                        return json.loads(snippet)
                    except Exception:
                        break
        start = text.find("{", start + 1)
    return None

def vllm_chat(base_url: str, model: str, messages: list, temperature: float = 0.0, max_tokens: int = 512, timeout: float = 60) -> str:
    url = f"{base_url}/chat/completions"
    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    r = requests.post(url, json=payload, timeout=timeout)
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"vLLM error {r.status_code}: {r.text[:500]}")
    data = r.json()
    return data["choices"][0]["message"]["content"]

def image_to_data_url(image_bytes: bytes, content_type: str) -> str:
    b64 = base64.b64encode(image_bytes).decode("utf-8")
    ct = content_type if content_type else "image/png"
    return f"data:{ct};base64,{b64}"

def parse_letters_deterministic(transcript: str) -> List[str]:
    """
    Best-effort deterministic parsing: handles 'c a t', 'cee ay tee', NATO, etc.
    """
    if not transcript:
        return []
    t = transcript.strip().lower()
    t = re.sub(r"[^a-z\s\-]", " ", t)
    tokens = [x for x in t.split() if x]

    letters: List[str] = []
    for tok in tokens:
        if tok in NATO:
            letters.append(NATO[tok])
        elif tok in LETTER_HOMOPHONES:
            letters.append(LETTER_HOMOPHONES[tok])
        elif len(tok) == 1 and _letter_re.fullmatch(tok):
            letters.append(tok)
        elif len(tok) > 1 and tok.isalpha():
            # SR sometimes concatenates letter sounds into a word
            # (e.g. child spells N-E-C-E-S-S-A-R-Y, SR outputs "necessary")
            # Split into individual letters as a last resort
            for c in tok:
                letters.append(c)
        else:
            pass

    return letters

def parse_letters_with_llm(transcript: str) -> Tuple[List[str], str]:
    """
    Use Nemotron text model to convert transcript -> letters JSON.
    """
    system = (
        "You convert a child's spoken spelling into individual letters. "
        "The child is spelling a word one letter at a time, but speech recognition "
        "often garbles individual letters into words. For example:\n"
        "- 'let e cessary' means the child said N-E-C-E-S-S-A-R-Y\n"
        "- 'are a see e' means R-A-C-E\n"
        "- 'bee you tea full' means B-E-A-U-T-I-F-U-L\n"
        "- 'age a are em' means H-A-R-M\n"
        "Output only valid JSON. No markdown."
    )
    user = (
        "Extract the individual letters this child was trying to spell from the transcript.\n"
        "The speech recognizer often converts letter sounds into words:\n"
        "- Letter sounds like 'en' or 'and' may mean N\n"
        "- 'are' or 'our' may mean R\n"
        "- 'see' or 'sea' may mean C\n"
        "- 'double you' or 'dub' may mean W\n"
        "- 'why' may mean Y\n"
        "- 'age' or 'each' may mean H\n"
        "- 'eye' may mean I\n"
        "- 'oh' may mean O\n"
        "- 'you' may mean U\n"
        "- 'be' or 'bee' may mean B\n"
        "Rules:\n"
        "- Output JSON only: {\"letters\":[\"a\",\"b\"],\"confidence\":\"high|medium|low\"}\n"
        "- letters must be a-z only\n"
        "- If the transcript contains a complete word (not spelled letters), try to extract the individual letters the child likely said\n"
        f"Transcript: {transcript!r}\n"
    )
    content = vllm_chat(
        VLLM_TEXT_BASE,
        VLLM_TEXT_MODEL,
        messages=[{"role":"system","content":system},{"role":"user","content":user}],
        temperature=0.0,
        max_tokens=200,
    )
    obj = extract_json_object(content) or {}
    letters = obj.get("letters") or []
    conf = obj.get("confidence") or "low"
    out = []
    for x in letters:
        if isinstance(x, str):
            x = x.strip().lower()
            if _letter_re.fullmatch(x):
                out.append(x)
    return out, conf

def extract_words_with_vl(image_bytes: bytes, content_type: str) -> List[str]:
    """
    Uses Nemotron VL via vLLM OpenAI /chat/completions with an image_url (data URL).
    """
    data_url = image_to_data_url(image_bytes, content_type)
    system = "You extract spelling words from images. Output only valid JSON. No markdown."
    user_text = (
        "Extract the spelling list from this image.\n"
        "Return JSON only in the form: {\"words\":[...]}\n"
        "Rules:\n"
        "- words only, lowercase\n"
        "- remove numbering/bullets/punctuation\n"
        "- split combined lines into separate words\n"
        "- no extra keys, no commentary\n"
    )
    user_msg = {
        "role": "user",
        "content": [
            {"type": "text", "text": user_text},
            {"type": "image_url", "image_url": {"url": data_url}},
        ],
    }

    content = ""
    words = []

    # Retry up to 2 times (VL model can sometimes return bad output)
    for attempt in range(2):
        try:
            content = vllm_chat(
                VLLM_VL_BASE,
                VLLM_VL_MODEL,
                messages=[{"role":"system","content":system}, user_msg],
                temperature=0.0,
                max_tokens=800,
            )
        except Exception as e:
            print(f"[ExtractWords] vLLM call failed (attempt {attempt+1}): {e}")
            if attempt == 0:
                continue
            raise

        print(f"[ExtractWords] VL response (attempt {attempt+1}): {content[:500]}")
        obj = extract_json_object(content)
        if obj and isinstance(obj.get("words"), list):
            words = [normalize_word(w) for w in obj["words"] if normalize_word(w)]
        if words:
            break
        print(f"[ExtractWords] No words parsed from response, attempt {attempt+1}")

    seen = set()
    out = []
    for w in words:
        if w and w not in seen:
            seen.add(w)
            out.append(w)
        if len(out) >= MAX_WORDS:
            break
    return out

def asr_transcribe(audio_bytes: bytes, filename: str) -> str:
    """Transcribe audio using ElevenLabs Scribe v2 API."""
    if not ELEVENLABS_API_KEY:
        raise HTTPException(status_code=501, detail="ELEVENLABS_API_KEY not configured (set env or use UI live transcript).")
    url = "https://api.elevenlabs.io/v1/speech-to-text"
    headers = {"xi-api-key": ELEVENLABS_API_KEY}
    files = {"file": (filename, audio_bytes)}
    data = {"model_id": "scribe_v2", "language_code": "en"}
    try:
        r = requests.post(url, headers=headers, files=files, data=data, timeout=ASR_TIMEOUT_S)
        r.raise_for_status()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"ElevenLabs ASR error: {e}")
    result = r.json()
    return (result.get("text") or "").strip()

# ---------- API models ----------
class ExtractWordsResponse(BaseModel):
    words: List[str]

class StartSessionRequest(BaseModel):
    words: List[str]
    student_name: Optional[str] = "Student"

class StartSessionResponse(BaseModel):
    session_id: str
    idx: int
    word: str
    total: int

class AskResponse(BaseModel):
    session_id: str
    idx: int
    word: str
    prompt_text: str

class AnswerResponse(BaseModel):
    session_id: str
    idx: int
    word: str
    transcript: str
    letters: str
    correct: bool
    attempts_for_word: int
    feedback_text: str
    next_idx: int
    done: bool
    score_correct: int
    score_total: int
    wrong_words: List[str] = []

class WordContextRequest(BaseModel):
    word: str
    session_id: str

class WordContextResponse(BaseModel):
    word: str
    definition: str
    sentence: str

# ---------- Routes ----------
@app.get("/healthz")
def healthz():
    return {"ok": True, "ts": now_ms()}


def _generate_word_context(session: dict, word: str) -> dict:
    """
    Generate a child-friendly definition and example sentence for a word.
    Results are cached in the session to avoid redundant LLM calls.
    Skips entirely if a previous call already failed (avoids repeated timeouts).
    """
    cache = session.setdefault("word_context", {})
    if word in cache:
        return cache[word]

    # Track consecutive failures; give up after 3 in a row
    if session.get("_context_failures", 0) >= 3:
        return {"definition": "", "sentence": ""}

    system = (
        "You are a helpful spelling bee pronouncer for a 9-year-old child. "
        "Given a word, you MUST provide a real, child-friendly definition and an example sentence.\n"
        "Rules:\n"
        "- The definition should be one short sentence a child can understand.\n"
        "- The example sentence should use the word naturally.\n"
        "- Do NOT say 'a spelling word' — always give a real definition.\n"
        '- Output JSON only: {"definition":"...","sentence":"..."}\n'
        "- No markdown, no extra keys, no commentary.\n"
    )
    user = f'Give me a simple definition and example sentence for the word "{word}".'

    try:
        content = vllm_chat(
            VLLM_TEXT_BASE,
            VLLM_TEXT_MODEL,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
            temperature=0.3,
            max_tokens=150,
            timeout=8,
        )
        obj = extract_json_object(content) or {}
        defn = (obj.get("definition") or "").strip()
        sent = (obj.get("sentence") or "").strip()
        # Reject useless placeholder answers from the LLM
        if defn.lower() in ("", "a spelling word", "a spelling word.", "it is a spelling word."):
            defn = ""
        result = {"definition": defn, "sentence": sent}
        # Reset failure counter on success
        if defn:
            session["_context_failures"] = 0
    except Exception as exc:
        print(f"[WordContext] LLM failed for '{word}': {exc}")
        session["_context_failures"] = session.get("_context_failures", 0) + 1
        result = {"definition": "", "sentence": ""}

    # Only cache if we got a real definition; allow retries otherwise
    if result["definition"]:
        cache[word] = result
    return result


class TTSRequest(BaseModel):
    text: str


def _magpie_tts(text: str) -> bytes:
    """Synthesize speech using NVIDIA Magpie TTS via Riva gRPC."""
    metadata = [
        ("function-id", MAGPIE_TTS_FUNCTION_ID),
        ("authorization", f"Bearer {MAGPIE_TTS_API_KEY}"),
    ]
    auth = riva.client.Auth(
        uri=MAGPIE_TTS_URL,
        use_ssl=MAGPIE_TTS_USE_SSL,
        metadata_args=metadata,
    )
    tts_service = riva.client.SpeechSynthesisService(auth)
    resp = tts_service.synthesize(
        text,
        voice_name=MAGPIE_TTS_VOICE,
        language_code=MAGPIE_TTS_LANGUAGE,
        encoding=riva.client.AudioEncoding.LINEAR_PCM,
        sample_rate_hz=22050,
    )
    # Convert raw PCM to WAV for browser playback
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)  # 16-bit
        wf.setframerate(22050)
        wf.writeframes(resp.audio)
    return buf.getvalue()


def _elevenlabs_tts(text: str) -> bytes:
    """Synthesize speech using ElevenLabs API (fallback)."""
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE_ID}"
    headers = {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
    }
    body = {
        "text": text,
        "model_id": ELEVENLABS_MODEL_ID,
    }
    r = requests.post(url, json=body, headers=headers, params={"output_format": "mp3_22050_32"}, timeout=15)
    r.raise_for_status()
    return r.content


@app.post("/tts")
async def tts(req: TTSRequest):
    """Convert text to speech. Tries Magpie TTS first, falls back to ElevenLabs."""
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="Empty text")

    # Try Magpie TTS first
    if MAGPIE_TTS_API_KEY:
        try:
            audio = _magpie_tts(req.text)
            return Response(content=audio, media_type="audio/wav")
        except Exception as e:
            print(f"[TTS] Magpie TTS failed, trying ElevenLabs fallback: {e}")

    # Fall back to ElevenLabs
    if ELEVENLABS_API_KEY:
        try:
            audio = _elevenlabs_tts(req.text)
            return Response(content=audio, media_type="audio/mpeg")
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"ElevenLabs TTS failed: {e}")

    raise HTTPException(status_code=501, detail="No TTS provider configured (set MAGPIE_TTS_API_KEY or ELEVENLABS_API_KEY)")


@app.post("/extract_words", response_model=ExtractWordsResponse)
async def extract_words(file: UploadFile = File(...)):
    img = await file.read()
    if not img:
        raise HTTPException(status_code=400, detail="Empty image upload")
    try:
        words = extract_words_with_vl(img, file.content_type or "image/png")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"VL extraction failed: {e}")

    if not words:
        raise HTTPException(status_code=422, detail="No words extracted. Try a clearer image or edit list manually.")
    return {"words": words}

@app.post("/session/start", response_model=StartSessionResponse)
def start_session(req: StartSessionRequest):
    words = [normalize_word(w) for w in req.words if normalize_word(w)]
    if not words:
        raise HTTPException(status_code=400, detail="No valid words")

    session_id = str(uuid.uuid4())
    SESSIONS[session_id] = {
        "student_name": req.student_name or "Student",
        "words": words,
        "idx": 0,
        "attempts": {},  # idx -> attempts
        "score_correct": 0,
        "score_total": 0,
        "wrong_words": [],  # words the child got wrong (exhausted retries)
        "word_context": {},  # word -> {"definition": ..., "sentence": ...}
        "created_ms": now_ms(),
    }
    return {
        "session_id": session_id,
        "idx": 0,
        "word": words[0],
        "total": len(words),
    }

@app.post("/turn/ask", response_model=AskResponse)
def turn_ask(session_id: str = Form(...)):
    s = SESSIONS.get(session_id)
    if not s:
        raise HTTPException(status_code=404, detail="Unknown session_id")
    idx = s["idx"]
    words = s["words"]
    if idx >= len(words):
        raise HTTPException(status_code=409, detail="Session already complete")

    word = words[idx]

    # Generate definition + example sentence (cached per session, best-effort)
    try:
        ctx = _generate_word_context(s, word)
        definition = ctx.get("definition", "")
        sentence = ctx.get("sentence", "")
    except Exception:
        definition = ""
        sentence = ""

    # Build prompt with context
    if definition:
        meaning_part = f"{word} means {definition}"
        if sentence:
            meaning_part += f" For example: {sentence}"
    else:
        meaning_part = ""

    if idx == 0:
        base = f"Spell {word}. Say one letter at a time."
    else:
        base = f"Spell {word}."

    prompt_text = f"{base} {meaning_part}".strip() if meaning_part else base

    return {"session_id": session_id, "idx": idx, "word": word, "prompt_text": prompt_text}

@app.post("/turn/answer", response_model=AnswerResponse)
async def turn_answer(
    session_id: str = Form(...),
    audio: Optional[UploadFile] = File(None),
    transcript: Optional[str] = Form(None),
):
    s = SESSIONS.get(session_id)
    if not s:
        raise HTTPException(status_code=404, detail="Unknown session_id")

    idx = s["idx"]
    words = s["words"]
    if idx >= len(words):
        return {
            "session_id": session_id,
            "idx": idx,
            "word": "",
            "transcript": "",
            "letters": "",
            "correct": True,
            "attempts_for_word": 0,
            "feedback_text": "All done!",
            "next_idx": idx,
            "done": True,
            "score_correct": s["score_correct"],
            "score_total": s["score_total"],
            "wrong_words": s["wrong_words"],
        }

    target = words[idx]

    # 1) Get transcripts from all available sources
    browser_tx = (transcript or "").strip()
    asr_tx = ""
    if audio is not None:
        audio_bytes = await audio.read()
        if audio_bytes:
            asr_tx = asr_transcribe(audio_bytes, audio.filename or "audio.webm")

    # Pick the primary transcript; keep both for letter extraction
    tx = browser_tx or asr_tx
    if not tx:
        raise HTTPException(status_code=400, detail="Provide transcript or audio")

    # 2) Parse letters from all available transcripts, keep best result
    candidates = []

    if browser_tx:
        browser_letters = parse_letters_deterministic(browser_tx)
        candidates.append(("browser_det", browser_letters))
    if asr_tx:
        asr_letters = parse_letters_deterministic(asr_tx)
        candidates.append(("asr_det", asr_letters))

    # Pick candidate closest to target length (but at least 1 letter)
    def score_candidate(letters):
        if not letters:
            return 9999
        return abs(len(letters) - len(target))

    candidates.sort(key=lambda c: score_candidate(c[1]))
    letters_list = candidates[0][1] if candidates else []
    source = candidates[0][0] if candidates else "none"

    # 3) Check deterministic result; fall back to LLM if it doesn't match
    used_llm = False
    conf = "n/a"
    det_spelled = normalize_word("".join(letters_list))
    target_norm = normalize_word(target)

    if det_spelled != target_norm:
        # Deterministic didn't match — try LLM on the combined transcript
        combined_tx = f"{browser_tx} | {asr_tx}".strip(" |") if (browser_tx and asr_tx) else tx
        try:
            llm_letters, conf = parse_letters_with_llm(combined_tx)
            llm_norm = normalize_word("".join(llm_letters))
            # Accept LLM result if it matches target OR has more letters than det
            if llm_norm == target_norm or len(llm_letters) > len(letters_list):
                letters_list = llm_letters
                used_llm = True
                source = "llm"
        except Exception:
            pass

    spelled = "".join(letters_list)
    spelled_norm = normalize_word(spelled)

    # 4) Grade — also accept if SR recognized the whole word directly
    correct = (spelled_norm == target_norm)

    if not correct:
        # SR sometimes outputs the target word itself from letter-by-letter speech
        for src_tx in [browser_tx, asr_tx]:
            if src_tx and normalize_word(src_tx) == target_norm:
                correct = True
                spelled_norm = target_norm
                break
            # Check individual tokens too (SR may add filler around the word)
            for tok in src_tx.lower().split() if src_tx else []:
                if normalize_word(tok) == target_norm:
                    correct = True
                    spelled_norm = target_norm
                    break
            if correct:
                break

    # 5) Update attempts + score
    attempts = s["attempts"].get(idx, 0) + 1
    s["attempts"][idx] = attempts
    s["score_total"] += 1
    if correct:
        s["score_correct"] += 1

    done = False
    feedback = ""
    next_idx = idx

    if correct:
        next_idx = idx + 1
        s["idx"] = next_idx
        if next_idx >= len(words):
            done = True
            feedback = f"Great job! You finished all {len(words)} words."
        else:
            feedback = f"Nice! {target} is correct. Next word."
    else:
        if attempts <= RETRY_ON_WRONG:
            feedback = "Not quite. Try again."
        else:
            reveal = "-".join(list(target_norm))
            feedback = f"Not quite. The correct spelling is {reveal}. Next word."
            s["wrong_words"].append(target)
            next_idx = idx + 1
            s["idx"] = next_idx
            if next_idx >= len(words):
                done = True
                feedback = f"Not quite. The correct spelling was {reveal}. You're done for today!"

    return {
        "session_id": session_id,
        "idx": idx,
        "word": target,
        "transcript": f"[{source}] browser={browser_tx!r} asr={asr_tx!r}" if (browser_tx and asr_tx) else tx + (f" [{source}]" if used_llm else ""),
        "letters": spelled_norm,
        "correct": correct,
        "attempts_for_word": attempts,
        "feedback_text": feedback,
        "next_idx": min(next_idx, len(words)),
        "done": done,
        "score_correct": s["score_correct"],
        "score_total": s["score_total"],
        "wrong_words": s["wrong_words"] if done else [],
    }


@app.post("/word/context", response_model=WordContextResponse)
def word_context(req: WordContextRequest):
    """Return definition + example sentence for a word. Guardrailed: word must be in session."""
    s = SESSIONS.get(req.session_id)
    if not s:
        raise HTTPException(status_code=404, detail="Unknown session_id")
    word_norm = normalize_word(req.word)
    if word_norm not in s["words"]:
        raise HTTPException(status_code=403, detail="Word not in session word list")
    ctx = _generate_word_context(s, word_norm)
    return {"word": word_norm, "definition": ctx.get("definition", ""), "sentence": ctx.get("sentence", "")}
