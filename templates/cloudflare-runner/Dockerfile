# The image a run starts from: Node, git, mu, and the agent CLI. Everything is installed here, once,
# when the image is built: a run's container has no internet and installs nothing.
FROM node:24-trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && apt-get clean

# Pin a release in production: .../releases/download/v0.1.2/muster-0.1.2.tgz
RUN npm install --global https://github.com/openmuster/muster/releases/latest/download/muster.tgz

# The agent you run. Add or swap for yours (for Codex: @openai/codex).
RUN npm install --global @anthropic-ai/claude-code

WORKDIR /workspace
