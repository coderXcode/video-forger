# ── Base image ───────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim

# ── System dependencies for Chromium (used by Remotion's renderer) ────────────
RUN apt-get update && apt-get install -y \
    # Chromium browser
    chromium \
    # Chromium runtime dependencies
    ca-certificates \
    fonts-liberation \
    fonts-noto \
    fonts-noto-color-emoji \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxkbcommon0 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    wget \
    curl \
    xdg-utils \
    # Needed for health check
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── Install npm dependencies (cached layer) ───────────────────────────────────
COPY package*.json ./
RUN npm install

# ── Copy application source ───────────────────────────────────────────────────
COPY src/          ./src/
COPY public/       ./public/
COPY index.html    ./
COPY remotion.config.ts ./
COPY tsconfig.json ./
COPY server.js     ./
COPY mcp-server.js ./

# ── Create project_mnts structure (overridden by volume mount at runtime) ──────
RUN mkdir -p project_mnts/uploaded_tsx project_mnts/generated_videos

EXPOSE 3000

# Chromium path used by Remotion renderer
ENV CHROMIUM_PATH=/usr/bin/chromium

CMD ["node", "server.js"]
