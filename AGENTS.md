# AGENTS.md

This project's agent/contributor guidance lives in **[CLAUDE.md](./CLAUDE.md)** — read it before
making changes. It covers the architecture, the deploy/verify loop, the design-system conventions,
and the data-source gotchas (Jellyfin, animeschedule).

Quick rules:
- React (Vite) + TypeScript SPA served by an Express + better-sqlite3 backend. There **is** a build
  step (`npm run build:all`). The old single-file `server.js` is kept as `server.legacy.cjs` for
  reference only — don't run or extend it.
- Two surfaces: the public **portal** (Kagura design system, `src/kagura.css`, scoped under
  `.kagura`/`.player`) and the authenticated **library manager** at `/manage` (shadcn). Don't
  hardcode colors — use the design tokens.
- All Jellyfin access is server-side; never expose the API key. Keep the scope guard and the HLS
  `api_key` stripping.
- Deploy is automated with two envs: pushing `dev` → GHCR → `deploy-dev` rolls `boop-watch-dev`
  (staging); pushing `main` → `deploy` rolls `boop-watch` (production, `watch.boopurno.es`), both in
  the `link-apps` ns via `kubectl rollout restart`. **Flow: feature branch → PR into `dev` → PR
  `dev` into `main`.** Don't build manually to deploy; don't commit straight to `dev`/`main`.
