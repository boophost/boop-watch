# Multi-stage build: Vite/React frontend (-> dist) + Express/TS backend (-> dist-server).
# better-sqlite3 is a native module, so the build stage needs python3/make/g++.
FROM node:20-alpine AS build
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build:all

FROM node:20-alpine
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/package*.json ./
RUN npm ci --omit=dev && apk del python3 make g++
EXPOSE 3000
ENV PORT=3000
ENV NODE_ENV=production
# wget (busybox) is available in alpine for the compose healthcheck
CMD ["node", "dist-server/index.js"]
