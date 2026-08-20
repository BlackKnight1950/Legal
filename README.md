# CCH Legal Team Worklist App

A lightweight portfolio + worklist app for the Cook County Health Office of the
General Counsel, modeled on the CCH PMOE Program & Project Management Center.
It reads and writes the **Current Worklist** Smartsheet (ID `4690720530059140`)
live, with cell-level autosave and add-assignment.

## What it does

**Portfolio Overview** — four metric cards:
- **Active Assignments** — `Status = In Progress`
- **Completed** — `Status = Completed`
- **On Hold** — `Status = Hold` or `Cancelled`
- **At Risk / Off Track** — `Risk Flag = At Risk` or `Off Track`

Plus workload-by-counsel bars and an "Assignments Needing Attention" table.

**Worklist** — the Smartsheet rendered as an editable grid. Click any cell to
edit; changes autosave back to Smartsheet. A ✓ in the Saved column confirms the
write. `＋ Add assignment` inserts a new row.

**Assignments** — browse view with Active / Completed / Cancelled / On Hold /
All filters, a search box, and a **Counsel** dropdown (the `Assigned to` column,
which is your PM equivalent).

## Architecture — why there are two pieces

A browser-only app can't hold a Smartsheet API token without exposing it to
anyone who opens dev tools. So:

- **`/backend`** — a tiny Express server that holds the token as an env var and
  proxies reads/writes to Smartsheet. Deploy to **Render**.
- **`/frontend`** — a single static `index.html`. Deploy to **GitHub Pages**
  *or* Render Static.

## Deploy

### 1. Backend on Render
1. Push this repo to GitHub.
2. In Render: **New → Blueprint**, point at this repo (uses `render.yaml`), OR
   **New → Web Service** with root dir `backend`, build `npm install`, start `npm start`.
3. Set env var **`SMARTSHEET_TOKEN`** (Smartsheet → Personal Settings → API Access → Generate token).
4. `SHEET_ID` is preset to `4690720530059140`. Optionally set `ALLOWED_ORIGINS`
   to your frontend URL (comma-separated) to lock down CORS.
5. Note the service URL, e.g. `https://cch-legal-backend.onrender.com`.

### 2. Frontend
**GitHub Pages:** put `frontend/index.html` at the repo (or `/docs`) root, enable Pages.
**Render Static:** already in `render.yaml`.

Then point the frontend at the backend. Either:
- Open the site, open the browser console, run:
  `localStorage.setItem('cch_api_base','https://cch-legal-backend.onrender.com')`
  and refresh; **or**
- Before deploying, add above the main `<script>` in `index.html`:
  `<script>window.CCH_API_BASE="https://cch-legal-backend.onrender.com";</script>`

## Local dev
```bash
cd backend
SMARTSHEET_TOKEN=your_token npm install && npm start   # http://localhost:3000
# then open frontend/index.html (defaults to localhost:3000)
```

## Notes / honest limitations
- Render free tier sleeps after inactivity; first load after idle takes ~30–50s to wake.
- Writes use `strict:false` to tolerate mixed-type cells.
- `Risk Flag` is free text in the sheet; only exact `At Risk` / `Off Track`
  (case-insensitive) count toward the At Risk card. Other values (e.g.
  "Enter the End Date") are ignored, which is the correct behavior.
- Contact columns (`Assigned to`) are written as plain text; Smartsheet resolves
  known contacts. For a new assignee, use a full email to be safe.
