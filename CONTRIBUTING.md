# Contributing to JARVIS

Thanks for helping make JARVIS more useful, faster, and more cinematic.

## Ground rules

- Keep the local-first default intact. Do not add silent analytics, telemetry, hidden network calls, or credential collection.
- Do not commit `.env.local`, private memory, downloaded models, app bundles, DMGs, recordings, screenshots containing personal data, or API keys.
- Treat microphone, camera, browser automation, filesystem writes, and device control as explicit permissions—not background capabilities.
- Prefer small, focused pull requests with a clear test note.

## Local workflow

```bash
npm install
npm start
npm run build
npm run lint
node --check bridge/server.mjs
```

For a native packaging change, also run:

```bash
npm run macos:build
npm run macos:dmg
```

## Pull requests

1. Create a branch from `main`.
2. Explain the user-facing result and privacy/security impact.
3. Include reproduction or validation steps.
4. Keep generated artifacts out of Git.

## Design principles

- A control should be obvious before it is flashy.
- Motion must remain responsive on normal hardware.
- Any action with a real-world consequence requires confirmation.
- A beautiful failure state beats a blank screen.
