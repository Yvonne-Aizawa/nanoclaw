# NanoClaw Playwright MCP Container
# Runs @playwright/mcp with system Chromium, bridged over HTTP.
# Extends nanoclaw-mcp-npx which provides the stdio→HTTP bridge.

FROM nanoclaw-mcp-npx

# Install Chromium and required system libraries
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

# Tell Playwright to use system Chromium instead of downloading its own
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Pre-install so first startup doesn't download the package
RUN npm install -g @playwright/mcp

# Default package — the bridge reads MCP_PACKAGE at runtime
ENV MCP_PACKAGE=@playwright/mcp
