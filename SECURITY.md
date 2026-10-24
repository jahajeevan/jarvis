# Security policy

## Supported version

Security fixes are applied to the latest `main` branch.

## Reporting a vulnerability

Please do **not** open a public issue for a vulnerability that could expose credentials, microphone/camera data, local files, or network access. Contact the repository maintainer privately through GitHub first, with a concise reproduction and impact description.

## Safety model

JARVIS starts in a read-only posture. Potentially effectful actions are gated behind explicit configuration (`JARVIS_ALLOW_WRITES=1`) and should remain confirmation-based in user interfaces. Treat external integrations and all browser/device control as privileged.
