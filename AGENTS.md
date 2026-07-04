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
- Deploy is automated: merge to `main` → GHCR → the workflow's `deploy` job rolls the k3s Deployment
  (`link-apps` ns) via `kubectl rollout restart`. Don't build manually to deploy.
- **Workflow:** Always commit your changes, push to a feature branch, and open a PR into `main`. Do not commit directly to `main`.
