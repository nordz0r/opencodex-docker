# syntax=docker/dockerfile:1
# Operator-owned packaging of upstream OpenCodex (https://github.com/lidge-jun/opencodex).
# Upstream does not publish an official container image; this Dockerfile follows the
# official "Remote Hub Deployment" recipe (https://opencodex.me/guides/remote-hub/).
#
# Build args are provided by CI (build.yml); local builds can pass them explicitly:
#   docker build \
#     --build-arg UPSTREAM_VERSION=2.40.0 \
#     --build-arg UPSTREAM_COMMIT=35ff3a462e786bd5efc394dfb1a8a5cc946e454f \
#     .

# Both stages must pin the SAME oven/bun tag BY DIGEST; a tag alone is not a production pin.
# Digest resolved from docker.io for oven/bun:1.4.0 (multi-arch OCI index).
ARG BUN_IMAGE=oven/bun:1.4.0@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6

FROM ${BUN_IMAGE} AS build
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /home/bun/app

# Upstream sources are fetched from the exact verified tag; the build context carries
# only this packaging repo (workflows, scripts, docs) — never a modified copy of OpenCodex.
ARG UPSTREAM_VERSION
ARG UPSTREAM_COMMIT
RUN git clone --depth 1 --branch "v${UPSTREAM_VERSION}" \
      https://github.com/lidge-jun/opencodex.git /tmp/opencodex-src \
    && cd /tmp/opencodex-src \
    && test "$(node -p "require('./package.json').version")" = "${UPSTREAM_VERSION}" \
    && test "$(git rev-parse HEAD)" = "${UPSTREAM_COMMIT}" \
    && echo "upstream verified: v${UPSTREAM_VERSION} @ ${UPSTREAM_COMMIT}"

COPY --chown=bun:bun scripts/verify-version.sh /tmp/verify-version.sh
RUN chmod +x /tmp/verify-version.sh

WORKDIR /tmp/opencodex-src
RUN --mount=type=cache,target=/home/bun/.bun/install/cache \
    bun install --frozen-lockfile

# Patch fast-uri to >=3.1.6 within upstream's specified "^3.1.5" range to resolve CVE-2026-75899 et al.
RUN bun update fast-uri

# Build the GUI (vite) exactly as upstream's own `build:gui` does.
RUN cd gui && bun install --frozen-lockfile && bun run build

# Remove development-only toolchains containing native binaries (e.g. tsc) before copying to runtime
RUN rm -rf /tmp/opencodex-src/node_modules/@typescript /tmp/opencodex-src/node_modules/typescript

FROM ${BUN_IMAGE} AS runtime
# Apply Debian security updates to patch base image CVEs (e.g. openssl, util-linux)
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*
WORKDIR /home/bun/app

ARG UPSTREAM_VERSION
ARG UPSTREAM_COMMIT

ENV OPENCODEX_HOME=/home/bun/.opencodex \
    OCX_API_TOKEN_FILE=/run/secrets/ocx_api_token \
    NODE_ENV=production

COPY --from=build --chown=bun:bun /tmp/opencodex-src/package.json ./package.json
COPY --from=build --chown=bun:bun /tmp/opencodex-src/bun.lock ./bun.lock
COPY --from=build --chown=bun:bun /tmp/opencodex-src/node_modules ./node_modules
COPY --from=build --chown=bun:bun /tmp/opencodex-src/src ./src
COPY --from=build --chown=bun:bun /tmp/opencodex-src/gui/dist ./gui/dist
COPY --from=build --chown=bun:bun /tmp/opencodex-src/bin ./bin
COPY --chown=bun:bun scripts/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh \
    && mkdir -p /home/bun/.opencodex \
    && chown -R bun:bun /home/bun

# OCI provenance labels: where the code came from, exactly.
LABEL org.opencontainers.image.title="opencodex" \
      org.opencontainers.image.description="Universal provider proxy for OpenAI Codex, Claude Code, Claude Desktop & Grok Build" \
      org.opencontainers.image.url="https://opencodex.me/" \
      org.opencontainers.image.source="https://github.com/lidge-jun/opencodex" \
      org.opencontainers.image.version="${UPSTREAM_VERSION}" \
      org.opencontainers.image.revision="${UPSTREAM_COMMIT}" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="opencodex contributors"

USER bun

VOLUME ["/home/bun/.opencodex"]

EXPOSE 10100

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD ["bun", "-e", "const r=await fetch('http://127.0.0.1:10100/healthz');if(!r.ok)process.exit(1)"]

ENTRYPOINT ["/home/bun/app/docker-entrypoint.sh"]
CMD ["bun", "run", "src/cli/index.ts", "start", "--port", "10100"]
