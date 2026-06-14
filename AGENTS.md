# AGENTS.md

This project's agent/contributor guidance lives in **[CLAUDE.md](./CLAUDE.md)** — read it before
making changes. It covers the architecture, the deploy/verify loop, the design-system conventions,
and the data-source gotchas (Jellyfin, animeschedule).

Quick rules:
- Single-file Express app (`server.js`), server-rendered HTML, **no build step / no client framework**.
- Style only via the `STYLE` design tokens — don't hardcode colors.
- All Jellyfin access is server-side; never expose the API key. Keep the scope guard.
- Deploy from the compose root: `cd /opt/boopurnoes && docker compose up -d --build boop-watch`.
