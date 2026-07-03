# Base stage with dependencies
FROM node:20-alpine AS deps
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm ci

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
FROM node:20-alpine
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY --from=build-frontend /app/dist ./dist
COPY --from=build-backend /app/dist-server ./dist-server
COPY --from=deps /app/package*.json ./
# Use npm ci from deps layer without dev dependencies
RUN npm ci --omit=dev && apk del python3 make g++
EXPOSE 3000
ENV PORT=3000
ENV NODE_ENV=production
CMD ["node", "dist-server/index.js"]
