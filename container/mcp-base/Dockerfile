# NanoClaw MCP Base Image
# Provides Node 22 + @modelcontextprotocol/sdk + express for all MCP server containers.
# Child images extend this with FROM nanoclaw-mcp-base.

FROM node:22-slim

WORKDIR /app

# Install common runtime dependencies shared by all MCP servers
COPY package.json ./
RUN npm install --omit=dev
