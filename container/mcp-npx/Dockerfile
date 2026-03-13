FROM nanoclaw-mcp-base

# Install bridge dependencies
COPY package.json ./
RUN npm install

# Compile TypeScript bridge
COPY tsconfig.json bridge.ts ./
RUN npx tsc

# Default port — override with MCP_PORT env var
EXPOSE 7700

# Required: MCP_PACKAGE=<npm-package-name>
# Optional: MCP_PORT=<port> (default 7700)
# All other env vars are forwarded to the subprocess.
ENTRYPOINT ["node", "dist/bridge.js"]
