# Cataly source-candidate recipe; build from the candidate root. See docs/container.md.
# Ubuntu, not Alpine: the pinned Bun assets need glibc.
FROM ubuntu:24.04

# Binary assets are sha256-verified. Top-level npm packages have exact versions.
# Cataly comes from this build context; native OMP consumes its bound upstream source lock.
# This recipe has not been built as part of the source port.
# Builds for linux/amd64 and linux/arm64; TARGETARCH is set by the builder.
ARG TARGETARCH
ARG NODE_VERSION=24.21.0
ARG NODE_SHA256_AMD64=6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff
ARG NODE_SHA256_ARM64=724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5
ARG BUN_VERSION=1.4.4
# GitHub release asset digests for bun-v1.4.4 (see docs/container.md).
ARG BUN_SHA256_AMD64=bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c
ARG BUN_SHA256_ARM64=baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e
ARG AGENT_MESSENGER_VERSION=2.40.0
ARG GH_VERSION=2.100.0
ARG GH_SHA256_AMD64=698c8d88cc19cc92bfe96bad58d10b2a5b274c52433d6dc57799c81f6139d5fc
ARG GH_SHA256_ARM64=33ccd2ad7ce639c927e1cb209e36555b0e1fbb89f7a38239c0568040ec758612

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git unzip jq ripgrep procps openssh-client \
    && rm -rf /var/lib/apt/lists/*

# gh, node and bun: pinned per-arch assets, each sha256-verified.
RUN set -eu; \
    case "${TARGETARCH}" in \
      amd64) NODE_ASSET=x64;    BUN_ASSET=x64;    GH_ASSET=amd64; \
             NODE_SHA256="${NODE_SHA256_AMD64}"; \
             BUN_SHA256="${BUN_SHA256_AMD64}";   GH_SHA256="${GH_SHA256_AMD64}" ;; \
      arm64) NODE_ASSET=arm64;   BUN_ASSET=aarch64; GH_ASSET=arm64; \
             NODE_SHA256="${NODE_SHA256_ARM64}"; \
             BUN_SHA256="${BUN_SHA256_ARM64}";   GH_SHA256="${GH_SHA256_ARM64}" ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/gh.deb \
      "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${GH_ASSET}.deb" \
    && echo "${GH_SHA256}  /tmp/gh.deb" | sha256sum -c - \
    && dpkg -i /tmp/gh.deb && rm /tmp/gh.deb && \
    curl -fsSL -o /tmp/node.tar.gz \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ASSET}.tar.gz" \
    && echo "${NODE_SHA256}  /tmp/node.tar.gz" | sha256sum -c - \
    && tar -xz -C /usr/local --strip-components=1 -f /tmp/node.tar.gz && rm /tmp/node.tar.gz && \
    curl -fsSL -o /tmp/bun.zip \
      "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${BUN_ASSET}.zip" \
    && echo "${BUN_SHA256}  /tmp/bun.zip" | sha256sum -c - \
    && unzip -j -o /tmp/bun.zip "*/bun" -d /usr/local/bin && rm /tmp/bun.zip \
    && chmod +x /usr/local/bin/bun && ln -sf /usr/local/bin/bun /usr/local/bin/bunx

# bun global packages install their launchers into $BUN_INSTALL/bin
ENV BUN_INSTALL=/usr/local

# The messenger stays a published npm package; OMP is the bound source toolchain below.
RUN bun install -g agent-messenger@${AGENT_MESSENGER_VERSION}

# .dockerignore admits source inputs only; no host state, credentials or node_modules.
COPY . /opt/omp-cataly
RUN set -eu; \
    bun install --frozen-lockfile --cwd /opt/omp-cataly \
    && bun install --frozen-lockfile --cwd /opt/omp-cataly/skills/cataly-mode/scripts \
    && bun install --frozen-lockfile --cwd /opt/omp-cataly/extension \
    && printf '#!/bin/sh\nexec bun /opt/omp-cataly/skills/cataly-mode/scripts/src/cli.ts "$@"\n' > /usr/local/bin/cataly \
    && printf '#!/bin/sh\nexec bun /opt/omp-cataly/src/cli.ts "$@"\n' > /usr/local/bin/cataly-harness \
    && chmod +x /usr/local/bin/cataly /usr/local/bin/cataly-harness
RUN ln -s /opt/omp-cataly/scripts/consumer/omp /usr/local/bin/omp

# run as a normal user; all state lives in the volumes named in compose.yaml
# the state dirs are pre-created with cataly ownership so fresh named volumes inherit it
RUN useradd -m -s /bin/bash cataly \
    && mkdir -p /home/cataly/projects /home/cataly/.cataly /home/cataly/.omp/agent/extensions \
      /home/cataly/.agents/skills /home/cataly/.config/gh /home/cataly/.config/agent-messenger \
    && ln -s /opt/omp-cataly/skills/cataly-mode /home/cataly/.agents/skills/cataly-mode \
    && ln -s /opt/omp-cataly/extension /home/cataly/.omp/agent/extensions/omp-cataly \
    && chown -R cataly:cataly /home/cataly /opt/omp-cataly

USER cataly
WORKDIR /home/cataly
ENV HOME=/home/cataly CATALY_TELEMETRY=0
RUN bun /opt/omp-cataly/scripts/source-dependencies.ts native /opt/omp-cataly /home/cataly >/dev/null

# The image starts no runtime server or session. Interactive commands can use docker compose exec.
CMD ["sleep", "infinity"]
