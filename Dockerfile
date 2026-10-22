# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS web
WORKDIR /src
COPY web/package*.json web/
RUN npm ci --prefix web
COPY web web
RUN npm run build --prefix web

FROM rust:1.88.0-bookworm@sha256:af306cfa71d987911a781c37b59d7d67d934f49684058f96cf72079c3626bfe0 AS build
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*
COPY rust rust
COPY docs/rhai docs/rhai
COPY examples examples
COPY static static
COPY web/core web/core
COPY --from=web /src/build-rust/core build-rust/core
COPY --from=web /src/web/node_modules web/node_modules
COPY web/package*.json web/
COPY licenses licenses
COPY scripts/generate-notices.py scripts/generate-notices.py
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/rust/target \
    cargo build --manifest-path rust/Cargo.toml --release --locked \
    && cp rust/target/release/little-spaces /usr/local/bin/little-spaces \
    && python3 scripts/generate-notices.py /notices --openssl-notice /usr/share/doc/libssl-dev/copyright

FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587 AS app
ARG IMAGE_REVISION=local
LABEL org.opencontainers.image.source="https://github.com/weatherjean/littlespaces" org.opencontainers.image.revision=$IMAGE_REVISION
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 10001 app && useradd -u 10001 -g app -m app \
    && install -d -m 0700 -o app -g app /data
COPY --from=build /usr/local/bin/little-spaces /usr/local/bin/little-spaces
COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/doc/littlespaces/
COPY licenses /usr/share/doc/littlespaces/licenses
COPY --from=build /notices /usr/share/doc/littlespaces/third-party
COPY deploy/container/app-entrypoint.sh deploy/container/app-health.sh /usr/local/bin/
RUN chmod 0755 /usr/local/bin/app-*.sh
USER 10001:10001
WORKDIR /data
ENTRYPOINT ["/usr/local/bin/app-entrypoint.sh"]
CMD ["serve", "/data/workspace", "5175"]

FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS verifier
ARG IMAGE_REVISION=local
LABEL org.opencontainers.image.source="https://github.com/weatherjean/littlespaces" org.opencontainers.image.revision=$IMAGE_REVISION
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/browsers
WORKDIR /opt/littlespaces/web
COPY web/package*.json ./
RUN npm ci && npx playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* /root/.npm \
    && groupadd -g 10002 verifier && useradd -u 10002 -g verifier -m verifier \
    && install -d -m 0700 -o verifier -g verifier /artifacts
COPY web/browser-harness.mjs ./
COPY deploy/container/verifier-entrypoint.sh deploy/container/verifier-health.mjs /usr/local/bin/
COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/doc/littlespaces/
RUN chmod 0755 /usr/local/bin/verifier-entrypoint.sh
USER 10002:10002
ENTRYPOINT ["/usr/local/bin/verifier-entrypoint.sh"]
