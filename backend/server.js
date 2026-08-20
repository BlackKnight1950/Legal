// CCH Legal Team App - Backend proxy
// Holds the Smartsheet API token server-side (env var) and proxies
// read/write calls so the token is NEVER exposed to the browser.

import express from "express";
import cors from "cors";

const app = express();
app.use(express.json({ limit: "5mb" }));

// ---- Config ----
const SMARTSHEET_TOKEN = process.env.SMARTSHEET_TOKEN;
const SHEET_ID = process.env.SHEET_ID || "4690720530059140";
const SS_BASE = "https://api.smartsheet.com/2.0";

// Comma-separated list of allowed origins (your GitHub Pages / Render static URL).
// If unset, allows all origins (fine for internal tools, tighten for production).
const ALLOWED = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
app.use(cors(ALLOWED.length ? { origin: ALLOWED } : {}));

if (!SMARTSHEET_TOKEN) {
  console.warn("WARNING: SMARTSHEET_TOKEN is not set. Set it in Render env vars.");
}

// Helper: call Smartsheet API
async function ss(path, options = {}) {
  const res = await fetch(`${SS_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${SMARTSHEET_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(data?.message || `Smartsheet error ${res.status}`);
    err.status = res.status;
    err.detail = data;
    throw err;
  }
  return data;
}

// ---- Routes ----

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, sheetId: SHEET_ID, tokenSet: Boolean(SMARTSHEET_TOKEN) });
});

// Full sheet: columns + rows
app.get("/api/sheet", async (_req, res) => {
  try {
    const data = await ss(`/sheets/${SHEET_ID}?level=2&include=objectValue`);
    res.json({
      sheetId: data.id,
      sheetName: data.name,
      permalink: data.permalink,
      columns: data.columns.map(c => ({
        id: c.id, index: c.index, title: c.title, type: c.type,
        options: c.options || null, primary: Boolean(c.primary),
      })),
      rows: data.rows.map(r => ({
        id: r.id, rowNumber: r.rowNumber,
        cells: r.cells.map(cell => ({
          columnId: cell.columnId,
          value: cell.value ?? null,
          displayValue: cell.displayValue ?? null,
        })),
      })),
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, detail: e.detail });
  }
});

// Update a single cell (autosave): { rowId, columnId, value }
app.put("/api/cell", async (req, res) => {
  const { rowId, columnId, value } = req.body || {};
  if (!rowId || !columnId) return res.status(400).json({ error: "rowId and columnId required" });
  try {
    const body = [{
      id: Number(rowId),
      cells: [{ columnId: Number(columnId), value: value === "" ? null : value, strict: false }],
    }];
    const data = await ss(`/sheets/${SHEET_ID}/rows`, {
      method: "PUT", body: JSON.stringify(body),
    });
    res.json({ ok: true, result: data.result });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, detail: e.detail });
  }
});

// Add a new row (new assignment): { cells: [{ columnId, value }] }
app.post("/api/row", async (req, res) => {
  const { cells } = req.body || {};
  try {
    const body = [{
      toBottom: true,
      cells: (cells || []).map(c => ({ columnId: Number(c.columnId), value: c.value, strict: false })),
    }];
    const data = await ss(`/sheets/${SHEET_ID}/rows`, {
      method: "POST", body: JSON.stringify(body),
    });
    res.json({ ok: true, result: data.result });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, detail: e.detail });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CCH Legal backend on :${PORT}`));
