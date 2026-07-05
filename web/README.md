# web/: Attritio AI frontend

Next.js 16 (App Router, Turbopack, Tailwind v4, IBM Plex fonts) app for the Attritio AI
attrition forecaster. Deployed to Vercel (project `repurpose-engine`).

The architecture, data model, forecast pipeline, lenses, caches, and gotchas are documented
in the repo-root **`../CLAUDE.md`** (single source of truth) and `../README.md`. Read those
first; do not treat this file as authoritative.

## Local dev / QA

```bash
npm install
npm run dev                 # dev server
npm run build               # production build (run before deploying to catch TS errors)
npm run start -- -p <port>  # serve the prod build for QA
```

Env vars (server-side only, in `.env.local`): `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `ELICIT_API_KEY`, `AMASS_API_KEY`.

Deploy (uploads the working dir; NOT git-triggered):

```bash
npx vercel deploy --prod --yes
```
