# syntax=docker/dockerfile:1
# Sandbox image for Python quickstarts (spec section 9). See node.Dockerfile for the rationale.
ARG BASE_IMAGE=python:3.12-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258
FROM ${BASE_IMAGE}

# Links the GHCR package to this repository (and lets it inherit the repository visibility).
LABEL org.opencontainers.image.source="https://github.com/Aditya-tec/quickstartrot" \
      org.opencontainers.image.description="QuickstartRot - sandbox for Python quickstarts"

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 1001 runner \
 && useradd --uid 1001 --gid 1001 --create-home --shell /bin/bash runner \
 && mkdir -p /work \
 && chown runner:runner /work

# Debian's /etc/profile resets PATH for login shells, which would drop the venv, so the venv is put
# back on PATH here. 99-qsr-env.sh loads variables set by set_env steps.
RUN printf '%s\n' 'export PATH=/work/.venv/bin:$PATH' > /etc/profile.d/10-venv.sh \
 && printf '%s\n' 'if [ -f "$HOME/.qsr_env" ]; then . "$HOME/.qsr_env"; fi' > /etc/profile.d/99-qsr-env.sh

USER 1001:1001
WORKDIR /work
# A pre-created venv that is already on PATH: `pip install x` just works and stays out of the system.
RUN python -m venv /work/.venv
ENV HOME=/home/runner \
    VIRTUAL_ENV=/work/.venv \
    PATH=/work/.venv/bin:$PATH \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1

CMD ["sleep", "infinity"]
