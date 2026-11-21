# The image a run starts from: Node, git, mu, and the agent CLI. Everything is installed here, once,
# when the image is built: a run's container has no internet and installs nothing.
FROM node:24-trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && apt-get clean

# One release, by its version: an image built twice is the same image, and "latest" is whatever was
# published last. Check the tarball against that release's SHA256SUMS when you change this.
ARG MUSTER_VERSION=0.1.2
RUN npm install --global https://github.com/openmuster/muster/releases/download/v${MUSTER_VERSION}/muster-${MUSTER_VERSION}.tgz

# The agent you run, at a version you chose: `npm view @anthropic-ai/claude-code version` says the
# current one. Add or swap for yours (for Codex: @openai/codex).
ARG AGENT_PACKAGE=@anthropic-ai/claude-code
ARG AGENT_VERSION
RUN test -n "$AGENT_VERSION" || { echo "pass --build-arg AGENT_VERSION=<version>: an agent CLI installed unpinned is whatever was published last" >&2; exit 1; } \
 && npm install --global "${AGENT_PACKAGE}@${AGENT_VERSION}"

WORKDIR /workspace
