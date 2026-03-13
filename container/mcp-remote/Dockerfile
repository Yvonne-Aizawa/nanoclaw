FROM nanoclaw-mcp-base

# Install proxy dependencies
COPY package.json ./
RUN npm install

# Compile TypeScript proxy
COPY tsconfig.json proxy.ts ./
RUN npx tsc

# Default port — override with MCP_PORT env var
EXPOSE 7700

# Required: MCP_REMOTE_URL=<upstream-mcp-url>
# Optional: MCP_PORT=<port> (default 7700)
#           MCP_HEADER_<Name>=<value> for each auth header to inject
#           (underscores in Name become hyphens, e.g. MCP_HEADER_Authorization)
ENTRYPOINT ["node", "dist/proxy.js"]
