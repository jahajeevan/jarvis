# JARVIS architecture

## Runtime layers

1. **Interface** — React, Three.js, WebGL, and CSS provide the holographic display, cinematic effects, and keyboard controls.
2. **Perception** — the browser requests microphone/camera permission only when those modes are used. MediaPipe drives the gesture layer.
3. **Bridge** — a local Node process hosts a WebSocket API on localhost, orchestrates the local model, speech transcription, memory, and optional web research.
4. **Brain** — Ollama serves Qwen locally at `127.0.0.1:11434` by default.
5. **Native shell** — a lightweight Swift/WKWebView app starts the local runtime and provides a macOS application experience.

## Data boundaries

| Data | Default location | Leaves the Mac? |
| --- | --- | --- |
| Prompt and model response | Local bridge + Ollama | No |
| Private memory | `~/Library/Application Support/JARVIS/memory.json` | No |
| Microphone / camera stream | Browser process | No, unless a chosen browser feature says otherwise |
| Fresh news query | Google News RSS | Yes, only for a fresh-web request |
| Optional cloud assistant mode | Chosen provider | Yes, only when configured |

## Why a bridge exists

The browser cannot safely run an LLM process, persist private local memory, or invoke local transcription binaries on its own. The bridge keeps those powers on localhost and provides a narrow message protocol to the UI.

## Performance approach

The visual layer favors bounded particles, short one-shot visual effects, and adaptive canvas work. The model runs outside the UI process, so a long answer does not freeze the interaction shell. Packaging does not embed models to keep the app distributable and updates manageable.
