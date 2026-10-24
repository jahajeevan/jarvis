# JARVIS demo guide

## Two-minute showcase

1. Start JARVIS and wait for **Local brain online**.
2. Press `L` for the scored standard Showtime sequence.
3. Press `W` for the Winter Arc presentation sequence.
4. Press `K`, approve camera access, then use the simple two-hand controls: spread, lift, rotate, and pinch.
5. Press `Space` and ask a normal local-model question.
6. Ask for a current topic to demonstrate opt-in fresh-web research.
7. Press `T` to show the typed command deck.

## If something does not work

- **“Waiting for local brain”** — run `ollama serve` and check that `ollama list` includes the configured model.
- **No voice input** — grant microphone access to JARVIS/browser; install `whisper-cpp` and FFmpeg for local transcription.
- **No hands detected** — grant camera access, use good front lighting, and keep both hands visible for calibration.
- **No presentation audio** — interact with the app once to unlock browser audio; macOS may also require a selected output device.
- **Native window is blank** — run `npm start` from the repository to inspect the local server output, then relaunch the app.
