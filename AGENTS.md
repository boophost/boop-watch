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
- Deploy is automated with two envs: pushing `dev` builds `:dev` → `deploy-dev` rolls `boop-watch-dev`
  (staging); pushing `main` builds `:latest` → `deploy` rolls `boop-watch` (production,
  `watch.boopurno.es`), both in the `link-apps` ns via `kubectl rollout restart`. Don't build manually
  to deploy.
- **Workflow: feature branch → PR to `dev` (with a test-plan checklist) → CI `build` green → merge
  → verify on staging.** Merging the PR *is* the deploy-to-staging step, not the end of the change:
  the merge rolls `boop-watch-dev`, and you then work through the test plan on the **merged PR
  page** by confirming rollout health and smoke-testing `/health` plus the relevant APIs. The change
  is done only when every checklist item is verified green on staging; fixes go up as follow-up
  feature → `dev` PRs. Private cluster access details live in
  [`boophost/boop-watch-ops`](https://github.com/boophost/boop-watch-ops). Promote to prod
  with a `dev` → `main` PR. **Never commit directly to `main`, and never push feature work straight
  to `dev`.** Bump `package.json` `version` with every shipped change (use patch bumps for follow-up
  commits in the same feature session).
- **Multiple local agents:** use `npm run agent-env -- up <slug>` so each agent gets its own
  worktree, branch, ports, and `DATA_DIR` (see CLAUDE.md → "Local agent environments"). Don't
  share one checkout across concurrent agents — that's how commits get mixed.
