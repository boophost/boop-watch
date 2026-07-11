# Every shipped commit bumps `version` in package.json (see CLAUDE.md), which would
# invalidate the npm ci layers on every build. Normalize the version out of the
# manifests npm ci sees, so the dependency layers only rebuild when deps change.
FROM node:22-alpine AS manifests
WORKDIR /app
COPY package.json package-lock.json ./
RUN node -e "for (const f of ['package.json','package-lock.json']) { const p='/app/'+f, j=JSON.parse(require('fs').readFileSync(p)); j.version='0.0.0'; if (j.packages?.['']) j.packages[''].version='0.0.0'; require('fs').writeFileSync(p, JSON.stringify(j)) }"

# Dependency stages. node:22-alpine gets better-sqlite3's prebuilt linuxmusl-x64
# binary (Node 20's ABI has no musl prebuild), so no python3/make/g++ toolchain.
FROM node:22-alpine AS deps
WORKDIR /app
COPY --from=manifests /app/package*.json ./
RUN npm ci

# Production-only deps, cached independently of source changes.
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY --from=manifests /app/package*.json ./
RUN npm ci --omit=dev

# Frontend build stage. Needs the real package.json — src/version.ts bakes
# its `version` into the bundle.
FROM deps AS build-frontend
COPY index.html vite.config.ts tsconfig*.json components.json package.json ./
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
# extraction). sqlite is the CLI (`sqlite3`) for DB ops — the preview-env seed
# does a `.backup` snapshot of series.sqlite, and it's handy for exec debugging.
RUN apk add --no-cache ffmpeg sqlite
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build-frontend /app/dist ./dist
COPY --from=build-backend /app/dist-server ./dist-server
# The real manifests (not the version-normalized ones from prod-deps).
COPY package*.json ./
EXPOSE 3000
ENV PORT=3000
ENV NODE_ENV=production
CMD ["node", "dist-server/index.js"]
