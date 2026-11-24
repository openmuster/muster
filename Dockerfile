# A board on a server: `mu serve` in a container, with everything it keeps on one volume.
#
#   docker build -t muster .
#   docker run -d --name board -p 4100:4100 -v muster-data:/data \
#     -e MUSTER_ALLOW_HOSTS=board.example.com muster
#
# The volume holds the board's database and files (/data/board) and its signing key and config
# (/data/config). Back it up with `docker exec board mu backup /data/backups/<name>.db`.

# Build the package from this checkout and pack it, the way a release is packed.
# The base is named by its digest, so the image is built on what was looked at: Dependabot proposes the next one.
FROM node:24-bookworm-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530 AS build
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile --filter muster... \
 && pnpm --filter muster build \
 && cd packages/muster && pnpm pack --pack-destination /out \
 && mv /out/muster-*.tgz /out/muster.tgz

# Run it: Node and the packed CLI, nothing else.
FROM node:24-bookworm-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530
COPY --from=build /out/muster.tgz /tmp/muster.tgz
RUN npm install --global /tmp/muster.tgz && rm /tmp/muster.tgz \
 && mkdir -p /data && chown node:node /data

USER node
ENV MUSTER_DIR=/data/board \
    MUSTER_CONFIG=/data/config \
    MUSTER_HOST=0.0.0.0 \
    MUSTER_PORT=4100
VOLUME /data
EXPOSE 4100

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.MUSTER_PORT || 4100) + '/api/board/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

ENTRYPOINT ["mu"]
# No token in the log: make one with `docker exec board mu token create --all`.
CMD ["serve", "--no-token"]
