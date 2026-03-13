FROM nanoclaw-mcp-base

# Install Python + uv so uvx can run Python-based MCP servers
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip curl ca-certificates \
    && curl -LsSf https://astral.sh/uv/install.sh | sh \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

ENV PATH="/root/.local/bin:${PATH}"

# Install bridge dependencies
COPY package.json ./
RUN npm install

# Compile TypeScript bridge
COPY tsconfig.json bridge.ts ./
RUN npx tsc

# Default port — override with MCP_PORT env var
EXPOSE 7700

# Required: MCP_PACKAGE=<uvx-package-name>
# Optional: MCP_PORT=<port> (default 7700)
# All other env vars are forwarded to the subprocess.
ENV MCP_COMMAND=uvx
ENTRYPOINT ["node", "dist/bridge.js"]
