#!/bin/bash
# Build all NanoClaw container images

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

# Build MCP base first (child images depend on it)
echo "Building MCP base image..."
${CONTAINER_RUNTIME} build --no-cache -t "nanoclaw-mcp-base:${TAG}" mcp-base/

# Generic bridges/proxy (can run any npx/uvx package or proxy a remote server)
echo "Building generic npx bridge image..."
${CONTAINER_RUNTIME} build --no-cache -t "nanoclaw-mcp-npx:${TAG}" mcp-npx/

echo "Building generic uvx bridge image..."
${CONTAINER_RUNTIME} build --no-cache -t "nanoclaw-mcp-uvx:${TAG}" mcp-uvx/

# Playwright MCP image (extends mcp-npx, adds Chromium)
echo "Building Playwright MCP image..."
${CONTAINER_RUNTIME} build --no-cache -t "nanoclaw-mcp-playwright:${TAG}" mcp-playwright/

# Build main agent image
IMAGE_NAME="nanoclaw-agent"
echo "Building NanoClaw agent container image..."
${CONTAINER_RUNTIME} build --no-cache -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Images: nanoclaw-mcp-base, nanoclaw-mcp-npx, nanoclaw-mcp-uvx,"
echo "        nanoclaw-mcp-playwright, ${IMAGE_NAME}"
echo ""
echo "Test agent with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
