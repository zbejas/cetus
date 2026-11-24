FROM oven/bun:1.4.2-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build:web

FROM docker:cli AS runtime
RUN apk add --no-cache ca-certificates docker-cli-compose libstdc++ \
 && ALPINE_BRANCH="$(. /etc/os-release; echo "$VERSION_ID" | cut -d. -f1,2)" \
 && apk add --no-cache --repository="https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_BRANCH}/community" docker-cli-buildx
COPY --from=build /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production
ENV CETUS_PORT=3000
ENV CETUS_DATA_DIR=/data
ENV CETUS_STACKS_DIR=/opt/stacks
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=20s --timeout=4s --start-period=10s --retries=3 \
  CMD sh -c 'if [ "$CETUS_MODE" = "worker" ]; then exit 0; fi; wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1'
CMD ["bun", "apps/server/src/index.ts"]
