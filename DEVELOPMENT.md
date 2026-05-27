# Development workflow

This is the playbook for making changes to Nordavix and shipping them
to production safely. Read this once; refer back when you forget the
exact command.

## TL;DR — the loop you'll repeat forever

```bash
# 1. Fresh start
git checkout main
git pull origin main

# 2. Branch for the work
git checkout -b feat/short-descriptive-name

# 3. Make changes, test locally (http://localhost:5173)
#    Vite hot-reloads on save, uvicorn auto-restarts on save.

# 4. Commit + push the BRANCH
git add .
git commit -m "Short description of what changed"
git push origin feat/short-descriptive-name

# 5. Open a PR on GitHub
#    A "Compare & pull request" banner appears at the top of the repo.
#    Click it, add a one-sentence description, click "Create pull request".

# 6. CI runs automatically — typically 2-3 minutes.
#    Backend: lint (ruff), typecheck, migrate, test
#    Frontend: typecheck, build

# 7. Vercel automatically deploys a PREVIEW URL for the branch.
#    Test it on real devices — not production yet.

# 8. When CI is green and preview looks right, click "Merge pull request".
#    Vercel deploys frontend to production (~1 min).
#    Fly.io deploys backend to production (~2-3 min).
```

That's the whole workflow. Most days you'll only need steps 1-5.

## First-time setup (only do once)

### 1. Install local dev environment

Prerequisites:
- Python 3.11+
- Node 20+
- Docker Desktop (https://docker.com/products/docker-desktop)

```bash
# Clone the repo (if you haven't already)
git clone https://github.com/pgusain333/nordavix.git
cd nordavix

# Set up backend
cd backend
python -m venv .venv
.venv/Scripts/python -m pip install -e .   # Mac/Linux: source .venv/bin/activate first

# Set up frontend
cd ../frontend
npm install

# Copy env files (ask the team for the actual values)
cp .env.example .env
cp .env.local.example .env.local   # in frontend/
```

### 2. Enable branch protection on `main` (CRITICAL — do this immediately)

Without this, you can accidentally push to `main` and ship broken code
to real users with no review.

1. Go to https://github.com/pgusain333/nordavix
2. Settings → Branches → Add branch protection rule
3. Branch name pattern: `main`
4. Check:
   - ✅ Require a pull request before merging
   - ✅ Require status checks to pass before merging
     - Select: `Backend — lint, typecheck, migrate, test`, `Frontend — typecheck, build`, `Deploy backend to Fly.io`
   - ✅ Require linear history
   - ✅ Do not allow bypassing the above settings
   - ✅ Block force pushes
5. Save

After this, even `git push origin main` is physically blocked.

## Running locally

Three terminals:

```bash
# Terminal 1 — infrastructure (Postgres + Redis)
docker compose up -d

# Terminal 2 — backend (http://127.0.0.1:8000)
cd backend
set -a; source .env; set +a                  # Mac/Linux: same
.venv/Scripts/python -m alembic upgrade head # apply any new migrations
.venv/Scripts/python -m uvicorn main:app --reload --port 8000

# Terminal 3 — frontend (http://localhost:5173)
cd frontend
npm run dev
```

Open http://localhost:5173. That's the fully isolated dev copy.
Production at nordavix.com doesn't know any of this is running.

## How auto-deploys work

| You push to | Vercel does | Fly.io does |
|-------------|-------------|-------------|
| Any branch (`feat/*`, `fix/*`, `docs/*`, etc.) | Creates a preview URL for that branch | Nothing |
| Pull request | Updates the preview URL on every new push | Nothing |
| `main` (only via merged PR) | Deploys to production at nordavix.com | Deploys to production at nordavix-api.fly.dev |

**Important**: PR previews share the production backend (Fly app).
For genuinely risky changes (DB migrations, API contract changes),
test thoroughly on `localhost` first or set up a separate staging
backend.

## Branch naming convention

Use a prefix that says what kind of change it is:

- `feat/` — new feature or behaviour
- `fix/` — bug fix
- `ui/` — visual / copy tweaks
- `docs/` — documentation only
- `chore/` — refactors, dependency bumps, config changes
- `perf/` — performance improvements

Examples: `feat/qbo-webhook-handler`, `fix/recon-status-bug`,
`ui/pricing-page-polish`, `docs/development-workflow`.

## Commit message convention

`<type>: <short description in lowercase>`

The type matches the branch prefix. The message should explain the
WHY when it isn't obvious from the diff.

Good:
- `fix: agentic flux query was hitting nonexistent columns`
- `ui: variance table chrome matches recon`
- `feat: GDPR-compliant cookie consent banner + preferences dialog`

Less good:
- `update`
- `fix bug`
- `WIP`

## Common scenarios

### "I made a mistake on my branch and want to start over"

```bash
git checkout main
git branch -D feat/the-mistake             # delete locally
git push origin --delete feat/the-mistake  # delete on GitHub
```

### "My PR has merge conflicts with main"

```bash
git checkout feat/your-branch
git pull origin main           # pulls in latest main into your branch
# Resolve conflicts in your editor, save, then:
git add .
git commit -m "Merge main into feat/your-branch"
git push origin feat/your-branch
```

### "I want to test my branch on someone else's computer"

Push the branch, then send them the Vercel preview URL (you'll see it
on the PR page once Vercel finishes deploying — usually under 1 min).

### "Something I just merged broke production"

Don't panic. Two options:

**Option A — Vercel UI rollback (frontend only)**:
- Vercel dashboard → Deployments → click any prior successful deploy → "Promote to Production"
- Instant, no git involved

**Option B — git revert (frontend AND backend)**:
```bash
git checkout main
git pull origin main
git log --oneline                              # find the bad commit hash
git revert <hash>                              # creates a new commit that undoes the bad one
git push origin main                           # triggers a new deploy with the revert
```

(`git revert` is safe — it doesn't rewrite history. The bad commit
is still in the log; we just push a "undo" commit on top.)

Then fix the underlying bug on a fresh branch and PR it through
normally.

## Database migrations — the one thing to be careful with

Most changes are pure code (frontend tweaks, backend logic). Those
are nearly impossible to ruin permanently because everything's
versioned in git.

**Database migrations** are different. They modify production data,
and a bad one is hard to undo.

### Safe migration workflow

```bash
# 1. Edit a model file (e.g., backend/models/variance.py)
# 2. Generate a migration:
cd backend
.venv/Scripts/python -m alembic revision --autogenerate -m "add my_new_column to variances"

# 3. ALWAYS read the generated migration file in backend/alembic/versions/
#    Alembic gets autogenerate wrong sometimes (especially for renames).
#    Edit by hand if needed.

# 4. Test it on your local DB:
.venv/Scripts/python -m alembic upgrade head

# 5. Confirm the app still works locally, then commit + PR like normal.

# 6. After merge, the production backend deploy on Fly will run the
#    migration during the new container's startup.
```

**Before merging any PR that touches DB schema**:
- Download a fresh Supabase backup (Database → Backups → Download)
- Tell yourself: "If this migration goes wrong, that backup is my
  insurance policy."
- Merge the PR.

## What's outside this workflow

These can't be changed via git PRs — they live in provider dashboards:

| Thing | Where |
|-------|-------|
| Production env vars (frontend) | Vercel → Settings → Environment Variables |
| Production env vars (backend) | `fly secrets set NAME=value` (uses Fly CLI) |
| Clerk SSO providers, JWT templates | Clerk dashboard |
| Stripe billing, plans | Stripe dashboard (when set up) |
| Custom domain DNS | Wherever nordavix.com is registered |
| Supabase database settings, RLS | Supabase dashboard |
| Cloudflare R2 buckets | Cloudflare dashboard |

When changing any of these, screenshot the before-state first — it's
your "undo" if something goes wrong.

## When in doubt, ask the AI assistant

If you're not sure what to do, ask Claude. Show it `git status` and
`git log --oneline -5` and ask what to do next.

The git commands are well-documented and recoverable from almost any
mistake. The only truly destructive operations are:
- `git push --force` (rewrites history on the remote — avoid)
- `git reset --hard` (throws away local changes — confirm first)
- Production database deletes / drops (always have a backup)

Everything else can be unwound.
