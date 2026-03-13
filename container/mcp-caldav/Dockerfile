FROM nanoclaw-mcp-base

# Install caldav-specific deps (inherits @modelcontextprotocol/sdk + express from base)
COPY package.json ./
RUN npm install

# Compile TypeScript
COPY tsconfig.json server.ts ./
RUN npx tsc

EXPOSE 7702
ENTRYPOINT ["node", "dist/server.js"]
