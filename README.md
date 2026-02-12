# Spelling Bee Assistant MVP (MicroK8s)


## Cluster nodes (from `microk8s kubectl get nodes -o wide`)
- controller: 192.168.1.75
- spark-01:   192.168.1.76
- spark-02:   192.168.1.77

This repo’s manifest pins:
- UI + gateway -> **controller**
- Nemotron VL -> **spark-01**
- Nemotron text -> **spark-02**
(using `nodeSelector: kubernetes.io/hostname: ...`)


This is a hackathon-ready MVP:
- Upload an image of a spelling list → extracts words with **Nemotron VL** (vLLM OpenAI server)
- Practice loop:
  - Browser speaks prompts/feedback (SpeechSynthesis)
  - Mic recording uploads audio OR you can use Chrome Live Transcript or type transcript
  - Gateway parses letters deterministically; falls back to **Nemotron text LLM** for letter extraction if needed

## Prereqs
- MicroK8s cluster with a controller node + 2 GPU nodes (DGX Spark)
- NVIDIA GPU Operator installed (or at least `nvidia.com/gpu` resource works)
- Hugging Face token that can pull NVIDIA models (store in K8s Secret)

## 0) Label nodes
Pick your node names:

```bash
microk8s kubectl get nodes -o wide
microk8s kubectl label node <controller-node> role=controller
microk8s kubectl label node <spark-01> role=gpu
microk8s kubectl label node <spark-02> role=gpu
```

## 1) Build & push gateway image into MicroK8s registry
Enable MicroK8s registry (one time):

```bash
microk8s enable registry
```

Build + push:

```bash
cd gateway
docker build -t localhost:32000/spellingbee-gateway:0.1 .
docker push localhost:32000/spellingbee-gateway:0.1
```

## 2) Create HF token secret (recommended via kubectl)
```bash
microk8s kubectl create ns spellingbee --dry-run=client -o yaml | microk8s kubectl apply -f -
microk8s kubectl -n spellingbee delete secret hf-token --ignore-not-found
microk8s kubectl -n spellingbee create secret generic hf-token --from-literal=token="<YOUR_HF_TOKEN>"
```

## 3) Deploy everything
```bash
microk8s kubectl apply -f k8s/spellingbee.yaml
microk8s kubectl -n spellingbee get pods -o wide
```

## 4) Access the UI
NodePort is **30080**:

```
http://<controller-node-ip>:30080
```

### Mic permission note
Most browsers require HTTPS for mic on non-localhost.
If mic is blocked on http://NODE_IP:30080:

Option A (easy): Port-forward to localhost:
```bash
microk8s kubectl -n spellingbee port-forward svc/spellingbee-ui 8080:8080
# open http://localhost:8080
```

Option B: Chrome flag:
- chrome://flags → "Insecure origins treated as secure" → add `http://<controller-node-ip>:30080`

## 5) Verify model endpoints
The gateway calls:
- Text LLM: `http://vllm-llama-31-8b:8000/v1`
- VL: `http://vllm-nemotron-vl:5566/v1`

If you want to deploy only the gateway+UI first:
- Edit `k8s/spellingbee.yaml` and comment out the vLLM deployments
- Use "Use demo list" in the UI
- Use Chrome Live Transcript or type transcript manually

## 6) Build & deploy ASR service (faster-whisper)

The ASR service runs on CPU (controller node) using `faster-whisper` with the `base.en` Whisper model.

Build + push:
```bash
cd asr
docker build -t localhost:32000/spellingbee-asr:0.1 .
docker push localhost:32000/spellingbee-asr:0.1
```

Or use the helper script:
```bash
bash scripts/build_push_asr.sh
```

The ASR Deployment and Service are already included in `k8s/spellingbee.yaml`.
After building the image, re-apply:
```bash
microk8s kubectl apply -f k8s/spellingbee.yaml
microk8s kubectl -n spellingbee rollout restart deploy/spellingbee-asr
microk8s kubectl -n spellingbee rollout restart deploy/spellingbee-gateway
```

Verify:
```bash
microk8s kubectl -n spellingbee get pods -o wide
# spellingbee-asr pod should be Running on controller
```

## 7) Hands-Free Mode (voice-driven spelling bee)

Inspired by [daily-co/nimble-pipecat](https://github.com/daily-co/nimble-pipecat):

1. Upload a word list image and click **Extract words**
2. Check **Hands-Free Mode** in the session card
3. Click **Start**
4. The app will automatically:
   - Speak each word prompt (browser TTS)
   - Listen via microphone with silence detection (VAD)
   - Send audio to the ASR service for transcription
   - Check spelling and speak feedback
   - Advance to the next word
5. Click **Stop Hands-Free** at any time to pause

### Architecture
```
Browser TTS ──► Speaker
Mic audio ────► ASR (faster-whisper, CPU) ──► Gateway ──► vLLM (letter parsing)
Image ────────► Gateway ──► Nemotron VL (word extraction)
```



### Note on `nvcr.io` images
If your cluster cannot pull from `nvcr.io` by default, you'll need to authenticate with an NGC API key on each node (containerd). Alternatively, switch the vLLM image in `k8s/spellingbee.yaml` to a community DGX Spark image (e.g. `scitrera/dgx-spark-vllm:0.14.0-t4`).
