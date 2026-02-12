# Spelling Bee Assistant

An AI-powered spelling practice app for kids. Upload a photo of a spelling list, and the app runs an interactive session where the child spells each word out loud (or by typing) and receives instant feedback.

## How It Works

1. **Upload a word list** — Take a photo of a spelling list (from school, a workbook, etc.) and upload it. An NVIDIA Nemotron VL vision-language model reads the image and extracts the words automatically. You can also type or paste words manually, or use a built-in demo list.

2. **Practice spelling** — The app presents each word one at a time. The child spells the word by:
   - Speaking the letters into the microphone (the app transcribes via ASR and parses individual letters)
   - Using Chrome's Live Transcript feature
   - Typing the letters directly

3. **Get instant feedback** — The app checks the spelling in real time, tells the child if they got it right, and moves on to the next word. If they get it wrong, they get another try before the correct answer is revealed.

4. **Hands-free mode** — For a fully voice-driven experience (inspired by [nimble-pipecat](https://github.com/daily-co/nimble-pipecat)): the app speaks each word prompt aloud via text-to-speech, listens for the child's response with automatic silence detection, checks the answer, and advances — no clicks required.

## Architecture

```
Browser TTS ──► Speaker
Mic audio ────► ASR (faster-whisper, CPU) ──► Gateway ──► vLLM (letter parsing)
Image ────────► Gateway ──► Nemotron VL (word extraction)
```

| Component | Description |
|-----------|-------------|
| **UI** | Single-page browser app (vanilla HTML/JS served by nginx) |
| **Gateway** | FastAPI service that orchestrates word extraction, session management, letter parsing, and scoring |
| **ASR** | Lightweight speech-to-text service using `faster-whisper` (Whisper `base.en` model, runs on CPU) |
| **Nemotron VL** | NVIDIA vision-language model (via vLLM) for reading words from photos |
| **Nemotron Text** | NVIDIA text LLM (via vLLM) used as fallback for letter extraction from ambiguous transcripts |

## Key Features

- **Image-to-word-list extraction** using a vision-language model
- **Multi-input spelling** — mic, live transcript, or keyboard
- **Deterministic letter parsing** with NATO alphabet, phonetic spelling, and homophone support (e.g., "bee" → B, "cee" → C)
- **LLM fallback** for tricky transcriptions the deterministic parser can't handle
- **Hands-free mode** with voice activity detection for a completely voice-driven session
- **Scoring and progress tracking** through the word list
- **ElevenLabs TTS** integration (optional) for natural-sounding voice prompts

## Setup

See [SETUP.md](SETUP.md) for deployment instructions, infrastructure requirements, and build steps.
