# Privacy and network boundaries

This copy of JARVIS runs locally from this Mac. The GitHub repository owner does
not receive microphone audio, prompts, files, or activity automatically. Git
only uploads anything if someone explicitly runs `git push`. Publishing source
code to GitHub never includes your ignored local settings, memory, model files,
or app build output.

## What remains on this Mac

- The JARVIS UI and bridge run on `localhost`.
- The default assistant brain is local Ollama (`qwen3:8b`) at
  `127.0.0.1:11434`. Prompts and responses remain on this Mac after the model
  download has completed.
- Kokoro speech output is generated locally after its model has been downloaded
  and cached by the browser.
- Local configuration and secrets belong in `.env.local`, which Git ignores.
- The DMG excludes `.env.local` deliberately. Personal keys are never copied
  into the installer; the packaged app uses local-only defaults.
- Browser and macOS permissions still control microphone, camera, and other
  device access.

## What can leave this Mac

- Set `JARVIS_BRAIN=claude` only if you intentionally want the original
  Claude Code cloud-agent compatibility mode. That mode sends requests to
  Anthropic; it is not enabled by default.
- The current no-key wake-word fallback is Chrome/Edge `SpeechRecognition`,
  which may use the browser vendor's speech service. It is not an offline
  wake-word engine.
- Opening web results, web search, or any connected service necessarily sends
  the minimum request needed to that service.

Do not add API keys to `VITE_*` variables: Vite packages those values into the
browser client. Keep integrations in the local bridge or an OS credential store
instead. Effectful actions remain disabled unless explicitly enabled.

## Before connecting personal accounts

Connect services one at a time, use their native OAuth flows, and grant only
the scopes JARVIS needs. Keep destructive or financial actions behind an
explicit confirmation step; no voice assistant should get blanket permission to
send, purchase, delete, or share.
