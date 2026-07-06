# Dependency stages. node:22-alpine gets better-sqlite3's prebuilt linuxmusl-x64
# binary (Node 20's ABI has no musl prebuild), so no python3/make/g++ toolchain.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

# Production-only deps, cached independently of source changes.
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# Frontend build stage
FROM deps AS build-frontend
COPY index.html vite.config.ts tsconfig*.json components.json ./
COPY public ./public
COPY src ./src
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
RUN npm run build

# Backend build stage
FROM deps AS build-backend
COPY tsconfig*.json ./
COPY server ./server
RUN npm run build:server

# Final production stage
FROM node:22-alpine
# ffmpeg/ffprobe are used by the library-import flow nodes (probe + subtitle
# extraction).
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/package*.json ./
COPY --from=build-frontend /app/dist ./dist
COPY --from=build-backend /app/dist-server ./dist-server
EXPOSE 3000
ENV PORT=3000
ENV NODE_ENV=production
CMD ["node", "dist-server/index.js"]
