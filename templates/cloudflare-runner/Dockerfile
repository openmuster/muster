# The image a run starts from: Node, git, mu, and the agent CLI. Everything is installed here, once,
# when the image is built: a run's container has no internet. The one thing a run installs is the
# repository's dependencies, while the Worker lets it read the npm registry and nothing else.
# Named by its digest, so the image is built on what was looked at. `docker buildx imagetools inspect
# node:24-trixie-slim` says the current one.
FROM node:24-trixie-slim@sha256:4d00acb4bcc42c454c4eb801526f7ad7f772ea3bd4fd168c5cc2e384abcbb9d4

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && apt-get clean

# One release, by its version and its checksum: an image built twice is the same image, and "latest" is
# whatever was published last. The build stops if the tarball isn't the one that release's SHA256SUMS
# names: change both together.
ARG MUSTER_VERSION=0.3.1-alpha.2
ARG MUSTER_SHA256=648f703eb48a34fc152d6a847824e4b6426958e334dda983909ad384123746a7
ADD --checksum=sha256:${MUSTER_SHA256} https://github.com/openmuster/muster/releases/download/v${MUSTER_VERSION}/muster-${MUSTER_VERSION}.tgz /tmp/muster.tgz
RUN npm install --global /tmp/muster.tgz && rm /tmp/muster.tgz

# A `pnpm` that fetches the version a repository pins (the latest without one) while the registry is
# open for its install, and keeps it, so the agent can still run it once the registry is closed. npm is Node's own; yarn comes through corepack or npx.
RUN corepack enable pnpm

# The agent you run, at a version you chose: `npm view @anthropic-ai/claude-code version` says the
# current one. Add or swap for yours (for Codex: @openai/codex).
ARG AGENT_PACKAGE=@anthropic-ai/claude-code
ARG AGENT_VERSION
RUN test -n "$AGENT_VERSION" || { echo "pass --build-arg AGENT_VERSION=<version>: an agent CLI installed unpinned is whatever was published last" >&2; exit 1; } \
 && npm install --global "${AGENT_PACKAGE}@${AGENT_VERSION}"

WORKDIR /workspace

# The Worker passes its own entrypoint; this keeps the container up when it is started some other way.
CMD ["sleep", "infinity"]
