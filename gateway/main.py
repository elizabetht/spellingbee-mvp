import base64
import json
import os
import re
import time
import uuid
from typing import Dict, List, Optional, Tuple

import requests
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

APP_NAME = "spellingbee-gateway"

# --------- Config (via env) ----------
# vLLM OpenAI-compatible endpoints
VLLM_TEXT_BASE = os.getenv("VLLM_TEXT_BASE", "http://vllm-nemotron-text:8000/v1")
VLLM_TEXT_MODEL = os.getenv("VLLM_TEXT_MODEL", "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16")

VLLM_VL_BASE = os.getenv("VLLM_VL_BASE", "http://vllm-nemotron-vl:5566/v1")
VLLM_VL_MODEL = os.getenv("VLLM_VL_MODEL", "nvidia/NVIDIA-Nemotron-Nano-12B-v2-VL-BF16")

# Optional: later plug in an ASR service here (Nemotron Speech or anything).
ASR_BASE = os.getenv("ASR_BASE", "")  # e.g. http://asr-service:8080
ASR_ENDPOINT = os.getenv("ASR_ENDPOINT", "/asr")  # POST audio -> {"text":"..."}
ASR_TIMEOUT_S = float(os.getenv("ASR_TIMEOUT_S", "30"))

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
    "ay":"a","a":"a",
    "bee":"b","be":"b","b":"b",
    "cee":"c","see":"c","sea":"c","c":"c",
    "dee":"d","d":"d",
    "ee":"e","e":"e",
    "ef":"f","f":"f",
    "gee":"g","g":"g",
    "aitch":"h","h":"h",
    "i":"i",
    "jay":"j","j":"j",
    "kay":"k","k":"k",
    "el":"l","l":"l",
    "em":"m","m":"m",
    "en":"n","n":"n",
    "oh":"o","o":"o",
    "pee":"p","p":"p",
    "cue":"q","queue":"q","q":"q",
    "are":"r","r":"r",
    "ess":"s","s":"s",
    "tee":"t","t":"t",
    "you":"u","u":"u",
    "vee":"v","v":"v",
    "doubleyou":"w","double-u":"w","doubleu":"w","w":"w",
    "ex":"x","x":"x",
    "why":"y","y":"y",
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

def vllm_chat(base_url: str, model: str, messages: list, temperature: float = 0.0, max_tokens: int = 512) -> str:
    url = f"{base_url}/chat/completions"
    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    r = requests.post(url, json=payload, timeout=60)
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
        else:
            # ignore non-letter tokens
            pass

    return letters

def parse_letters_with_llm(transcript: str) -> Tuple[List[str], str]:
    """
    Use Nemotron text model to convert transcript -> letters JSON.
    """
    system = (
        "You convert a child's spoken spelling into letters. "
        "Output only valid JSON. No markdown."
    )
    user = (
        "Extract spelled letters from this transcript.\n"
        "Rules:\n"
        "- Output JSON only: {\"letters\":[\"a\",\"b\"],\"confidence\":\"high|medium|low\"}\n"
        "- letters must be a-z only\n"
        "- If the child did not spell letters (they said the whole word), return empty letters and confidence low\n"
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

    content = vllm_chat(
        VLLM_VL_BASE,
        VLLM_VL_MODEL,
        messages=[{"role":"system","content":system}, user_msg],
        temperature=0.0,
        max_tokens=800,
    )
    obj = extract_json_object(content)
    words = []
    if obj and isinstance(obj.get("words"), list):
        words = [normalize_word(w) for w in obj["words"] if normalize_word(w)]

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
    if not ASR_BASE:
        raise HTTPException(status_code=501, detail="ASR_BASE not configured (set env ASR_BASE or use UI live transcript).")
    url = f"{ASR_BASE}{ASR_ENDPOINT}"
    files = {"file": (filename, audio_bytes)}
    r = requests.post(url, files=files, timeout=ASR_TIMEOUT_S)
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"ASR error {r.status_code}: {r.text[:500]}")
    data = r.json()
    return (data.get("text") or "").strip()

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

# ---------- Routes ----------
@app.get("/healthz")
def healthz():
    return {"ok": True, "ts": now_ms()}

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
    prompt_text = f"Spell {word}. Say one letter at a time."
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
        }

    target = words[idx]

    # 1) Get transcript
    tx = (transcript or "").strip()
    if not tx and audio is not None:
        audio_bytes = await audio.read()
        if not audio_bytes:
            raise HTTPException(status_code=400, detail="Empty audio upload")
        tx = asr_transcribe(audio_bytes, audio.filename or "audio.webm")

    if not tx:
        raise HTTPException(status_code=400, detail="Provide transcript or audio")

    # 2) Parse letters deterministically
    letters_list = parse_letters_deterministic(tx)

    # 3) If parsing looks weak, ask Nemotron text model to extract letters
    used_llm = False
    conf = "n/a"
    if len(letters_list) < 2 and len(target) >= 2:
        try:
            letters_list, conf = parse_letters_with_llm(tx)
            used_llm = True
        except Exception:
            pass

    spelled = "".join(letters_list)
    spelled_norm = normalize_word(spelled)
    target_norm = normalize_word(target)

    # 4) Grade deterministically
    correct = (spelled_norm == target_norm)

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
            feedback = "Good try. Let's try that word again. Spell it one letter at a time."
        else:
            reveal = "-".join(list(target_norm))
            feedback = f"Not quite. The correct spelling is {reveal}. Next word."
            next_idx = idx + 1
            s["idx"] = next_idx
            if next_idx >= len(words):
                done = True
                feedback = f"Not quite. The correct spelling was {reveal}. You're done for today!"

    return {
        "session_id": session_id,
        "idx": idx,
        "word": target,
        "transcript": tx + (f" (llm_conf={conf})" if used_llm else ""),
        "letters": spelled_norm,
        "correct": correct,
        "attempts_for_word": attempts,
        "feedback_text": feedback,
        "next_idx": min(next_idx, len(words)),
        "done": done,
        "score_correct": s["score_correct"],
        "score_total": s["score_total"],
    }
