# Security Policy

## Supported versions

Only the latest immutable image tag (`X.Y.Z`) receives security fixes; the
moving tags (`latest`, `X.Y`, `X`) always track it. Older exact tags are
frozen artifacts and are not patched — redeploy on a newer digest.

## Reporting a vulnerability

If the issue is in OpenCodex itself, report it upstream:
https://github.com/lidge-jun/opencodex/security/advisories

If the issue is in this packaging (Dockerfile, workflows, scripts), open a
private security advisory via
[GitHub → Security → Report a vulnerability](https://github.com/nordz0r/opencodex-docker/security/advisories/new).

## Packaging threat model

- The image never bakes credentials: no `auth.json`, no provider/OAuth
  tokens, no `.env`, no Windows config. The data admission token is read at
  runtime from `OCX_API_TOKEN_FILE`.
- Do not pass tokens via `ARG`, `ENV`, `COPY`, Compose YAML, or the command
  line — they land in image history and layer caches.
- Do not mount the Docker socket, host home, Codex home, SSH agent, or
  provider key files into the container.
- Only port `10100` (data plane) is exposed. The management listener on
  `10101` must stay bound to loopback inside the container's network
  namespace; publishing it defeats the hub trust model.
- Trivy scans block publication on `CRITICAL` and fixable `HIGH`
  vulnerabilities; exceptions live only in a versioned allowlist with a
  reason and an expiry.
- Builds run from the verified upstream tag; a version/commit mismatch fails
  the build instead of producing an image.
