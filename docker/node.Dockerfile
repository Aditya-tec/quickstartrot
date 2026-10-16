# syntax=docker/dockerfile:1
# Sandbox image for Node quickstarts (spec section 9): runs untrusted docs code, so it is minimal,
# non-root and holds no secrets. Built by .github/workflows/images.yml and pushed to GHCR.
#
# The base image is pinned BY DIGEST (supply-chain, and immune to a moving tag). images.yml mirrors
# it to GHCR and overrides BASE_IMAGE so CI never pulls anonymously from Docker Hub.
ARG BASE_IMAGE=node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
FROM ${BASE_IMAGE}

# Links the GHCR package to this repository (and lets it inherit the repository visibility).
LABEL org.opencontainers.image.source="https://github.com/Aditya-tec/quickstartrot" \
      org.opencontainers.image.description="QuickstartRot - sandbox for Node quickstarts"

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Globals the compiler's `run` allowlist relies on: `npx tsx <file>` and TypeScript.
RUN npm install --global --no-fund --no-audit tsx typescript \
 && npm cache clean --force

# Unprivileged user. uid 1001 matches the `--user 1001:1001` the executor starts the container with.
RUN groupadd --gid 1001 runner \
 && useradd --uid 1001 --gid 1001 --create-home --shell /bin/bash runner \
 && mkdir -p /work \
 && chown runner:runner /work

# Every command runs under `bash -l` (spec section 9); this loads variables set by set_env steps.
RUN printf '%s\n' 'if [ -f "$HOME/.qsr_env" ]; then . "$HOME/.qsr_env"; fi' > /etc/profile.d/99-qsr-env.sh

USER 1001:1001
WORKDIR /work
ENV HOME=/home/runner \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

CMD ["sleep", "infinity"]
