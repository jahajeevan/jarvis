# J.A.R.V.I.S.

**A local-first, cinematic desktop assistant for macOS.**

JARVIS combines a reactive holographic interface with a local Qwen model, offline speech-to-text, optional local neural speech, gesture controls, private memory, and opt-in web research. It is designed to feel like a showpiece while keeping your conversations and device data on your machine by default.

> This is a fan-made productivity and interface project. It is not affiliated with Marvel or any of its properties.

## What it can do

- Run a local Ollama brain (default: `qwen3:8b`)
- Listen through local Whisper speech-to-text and answer with local/browser TTS
- Remember explicitly saved preferences in a private local memory store
- Fetch current headlines when a question needs fresh information
- Offer a cinematic normal Showtime and a Winter Arc presentation mode
- Drive a real-time 3D Arc interface with keyboard and camera gesture input
- Package as a native macOS `.app` and distributable DMG
- Keep effectful computer actions opt-in; read-only is the default

## Architecture

```text
Microphone / Camera / Keyboard
            │
            ▼
 React + Three.js holographic UI (localhost)
            │ WebSocket
            ▼
 Local Node bridge ─────► Ollama / Qwen (127.0.0.1:11434)
       │       │
       │       ├─────────► whisper.cpp (local transcription)
       │       ├─────────► private memory.json (Application Support)
       │       └─────────► Google News RSS (only for fresh-web requests)
       ▼
 Native macOS shell (WKWebView) → JARVIS.app → DMG
```

Read the detailed design in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quick start

### 1. Prerequisites

- macOS (Apple Silicon recommended for the native package)
- Node.js 20 or newer
- [Ollama](https://ollama.com/)

```bash
ollama pull qwen3:8b
brew install whisper-cpp ffmpeg
```

Download a Whisper GGML model with the command recommended by your `whisper-cli` installation. JARVIS discovers common local model locations.

### 2. Run from source

```bash
git clone https://github.com/adewaskar/jarvis.git
cd jarvis
npm install
npm start
```

The bridge starts in read-only mode: it cannot modify files, click/type in a browser, run shell commands, or control devices unless you deliberately enable that capability.

### 3. Build the macOS app

```bash
npm run macos:build
npm run macos:dmg
```

The app is created at `build/JARVIS.app`; the installer is placed in `build/`. The model itself is not bundled: install Ollama and pull the model first.

## Controls

| Control | Result |
| --- | --- |
| `Space` | Start / stop a voice turn |
| `K` | Enter or leave Arc Control |
| `L` | Launch the standard Showtime sequence |
| `W` | Launch the Winter Arc sequence |
| `V` | Cycle available voice modes |
| `T` | Open the typed command deck |
| `Esc` | Close panels / leave an active mode |

### Arc Control

1. Show two open hands to calibrate.
2. Move hands apart or together to resize the field.
3. Move them up or down to change intensity.
4. Rotate the line between your hands to change spin.
5. Pinch one hand for an Arc pulse; hold two pinches to recalibrate.

Camera permission is required and can be managed in **System Settings → Privacy & Security → Camera**. See [docs/DEMO.md](docs/DEMO.md) for a presentation script and troubleshooting.

## Privacy and security

Local-first does not mean every feature is magically offline. The default model, memory, UI, and local speech pipeline remain on your Mac. Web research sends a query to the selected news/search service only when you ask for current information. Cloud/Claude compatibility is optional and disabled by default.

- Never commit `.env.local`, credentials, personal memory, downloaded models, the packaged app, or DMGs.
- Do not put secrets in `VITE_*` variables—those are visible in the browser.
- Keep external integrations scoped, explicit, and confirmation-gated.

Read [PRIVACY.md](PRIVACY.md) before connecting personal accounts and [SECURITY.md](SECURITY.md) before reporting a vulnerability.

## Configuration

```bash
cp .env.example .env.local
```

Useful settings include `JARVIS_BRAIN=ollama`, `JARVIS_OLLAMA_MODEL=qwen3:8b`, and `JARVIS_ALLOW_WRITES=1`. The last option authorizes potentially effectful actions; leave it unset for the safe default.

## Development

```bash
npm run build
npm run lint
node --check bridge/server.mjs
```

Contributions are welcome—start with [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Distributed under the [MIT License](LICENSE).
