FROM python:3.12-slim

# ffmpeg is required by faster-whisper for audio decoding
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

COPY requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download the whisper model at build time so startup is fast
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('base.en', device='cpu', compute_type='int8')"

COPY main.py /app/main.py

EXPOSE 8060
CMD ["uvicorn", "main:app", "--host=0.0.0.0", "--port=8060"]
