FROM node:20-slim

WORKDIR /app

# wget is used by the compose healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends wget \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public

EXPOSE 3000
CMD ["node", "server.js"]
