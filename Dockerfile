FROM node:20-bookworm-slim

# Install Chrome + xvfb for virtual display
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       wget gnupg ca-certificates xvfb xauth \
    && wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor > /usr/share/keyrings/google-chrome.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends google-chrome-stable \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

EXPOSE 3000

# Start Xvfb in background, then run Node
CMD ["sh", "-c", "Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp &  sleep 1 && DISPLAY=:99 node server.js"]
