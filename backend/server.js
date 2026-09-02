// CCH Legal Team App - Backend proxy
// Holds the Smartsheet API token server-side (env var) and proxies
// read/write calls so the token is NEVER exposed to the browser.

import express from "express";
import cors from "cors";

const app = express();
// Parse JSON for normal routes, but skip the raw attachment-upload path so a
// .json file upload isn't swallowed by the JSON body parser.
app.use((req, res, next) => {
  if (req.method === "POST" && req.path.startsWith("/api/attachment/")) return next();
  return express.json({ limit: "5mb" })(req, res, next);
});

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

const REPORT_ID = process.env.REPORT_ID || "3595186276880260";

// Additional case sheets shown as Worklist sub-tabs and folded into the
// Overview + Assignments views. Allowlisted so only these IDs can be proxied.
const OIIG_SHEET_ID = process.env.OIIG_SHEET_ID || "1102517701136260";
const FOIA_SHEET_ID = process.env.FOIA_SHEET_ID || "7437493396787076";
const EXTRA_SHEETS = { oiig: OIIG_SHEET_ID, foia: FOIA_SHEET_ID };

// Sheets whose attachments may be read/written through the proxy. Same set the
// case sheets are drawn from, so arbitrary sheet IDs can't be reached.
const ATTACH_SHEETS = new Set([String(SHEET_ID), String(OIIG_SHEET_ID), String(FOIA_SHEET_ID)]);

// Raw Smartsheet call that does NOT force JSON headers — used for binary
// downloads and raw uploads where ss() would corrupt the body.
async function ssRaw(path, options = {}) {
  return fetch(`${SS_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${SMARTSHEET_TOKEN}`,
      ...(options.headers || {}),
    },
  });
}

// Shared: fetch a sheet's columns + rows in our normalized shape.
async function fetchSheet(sheetId) {
  const data = await ss(`/sheets/${sheetId}?level=2&include=objectValue`);
  return {
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
  };
}

// ---- Routes ----

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, sheetId: SHEET_ID, reportId: REPORT_ID, tokenSet: Boolean(SMARTSHEET_TOKEN) });
});

// Report view (read-only source) + real sheet column metadata for write-back.
// Reports can't be written to, so we display report rows but resolve each
// cell's real sheet columnId (present in report cells) for autosave to the sheet.
app.get("/api/report", async (_req, res) => {
  try {
    // sheet columns give us type + options (report columns omit picklist options)
    const sheet = await ss(`/sheets/${SHEET_ID}?level=2`);

    const report = await ss(`/reports/${REPORT_ID}?pageSize=500&include=objectValue`);

    // Report columns, in display order, enriched with real sheet type/options.
    const columns = report.columns.map(rc => {
      const match = sheet.columns.find(sc => sc.title === rc.title);
      return {
        title: rc.title,
        type: match ? match.type : rc.type,
        options: match ? (match.options || null) : null,
        sheetColumnId: match ? match.id : null,
        width: rc.width || null,
        primary: Boolean(rc.primary),
      };
    });

    const rows = report.rows.map(r => ({
      rowId: r.id,
      sheetId: r.sheetId || Number(SHEET_ID),
      cells: r.cells.map(cell => ({
        columnId: cell.columnId,          // real sheet column id
        value: cell.value ?? null,
        displayValue: cell.displayValue ?? null,
      })),
    }));

    res.json({
      reportId: report.id,
      reportName: report.name,
      sheetId: SHEET_ID,
      permalink: report.permalink,
      columns,
      rows,
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, detail: e.detail });
  }
});

// Full sheet: columns + rows
app.get("/api/sheet", async (_req, res) => {
  try {
    res.json(await fetchSheet(SHEET_ID));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, detail: e.detail });
  }
});

// Case sheets (OIIG / FOIA): full columns + rows for their own Worklist sub-tabs.
app.get("/api/casesheet/:which", async (req, res) => {
  const which = String(req.params.which || "").toLowerCase();
  const id = EXTRA_SHEETS[which];
  if (!id) return res.status(404).json({ error: `Unknown case sheet '${which}'` });
  try {
    const out = await fetchSheet(id);
    out.which = which;
    res.json(out);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, detail: e.detail });
  }
});

// ---- Attachments ----
// Resolve a case-sheet key (oiig/foia) OR a raw sheetId to an allowlisted id.
function resolveAttachSheet(param) {
  const key = String(param || "").toLowerCase();
  if (EXTRA_SHEETS[key]) return String(EXTRA_SHEETS[key]);
  if (ATTACH_SHEETS.has(String(param))) return String(param);
  return null;
}

// List all attachments on a sheet, grouped by row id.
// GET /api/attachments/:sheet   (:sheet = "oiig" | "foia" | numeric sheetId)
// Returns { byRow: { <rowId>: [ {id,name,mimeType,sizeInKb,createdAt} ] } }
app.get("/api/attachments/:sheet", async (req, res) => {
  const sheetId = resolveAttachSheet(req.params.sheet);
  if (!sheetId) return res.status(404).json({ error: `Unknown sheet '${req.params.sheet}'` });
  try {
    // Paginate through all sheet attachments (row + sheet + comment scoped).
    const byRow = {};
    let page = 1, totalPages = 1;
    do {
      const data = await ss(`/sheets/${sheetId}/attachments?pageSize=500&page=${page}`);
      (data.data || []).forEach(a => {
        if (a.parentType !== "ROW") return;              // only row attachments
        const rid = String(a.parentId);
        (byRow[rid] = byRow[rid] || []).push({
          id: a.id,
          name: a.name,
          mimeType: a.mimeType || null,
          sizeInKb: a.sizeInKb ?? null,
          createdAt: a.createdAt || null,
        });
      });
      totalPages = data.totalPages || 1;
      page++;
    } while (page <= totalPages);
    res.json({ sheetId, byRow });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, detail: e.detail });
  }
});

// Download an attachment THROUGH the proxy (token never leaves the server).
// GET /api/attachment/:sheet/:attachmentId
app.get("/api/attachment/:sheet/:attachmentId", async (req, res) => {
  const sheetId = resolveAttachSheet(req.params.sheet);
  if (!sheetId) return res.status(404).json({ error: `Unknown sheet '${req.params.sheet}'` });
  const attId = Number(req.params.attachmentId);
  if (!attId) return res.status(400).json({ error: "attachmentId required" });
  try {
    // 1) get metadata → temporary signed download url + real filename
    const meta = await ss(`/sheets/${sheetId}/attachments/${attId}`);
    if (!meta.url) return res.status(404).json({ error: "attachment has no download url" });
    // 2) stream the bytes back to the browser as a download
    const fileRes = await fetch(meta.url);
    if (!fileRes.ok) return res.status(fileRes.status).json({ error: "fetch from storage failed" });
    const name = (meta.name || "attachment").replace(/["\\\r\n]/g, "_");
    res.setHeader("Content-Type", meta.mimeType || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    if (meta.sizeInKb) res.setHeader("Content-Length", Math.round(meta.sizeInKb * 1024));
    const buf = Buffer.from(await fileRes.arrayBuffer());
    res.end(buf);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, detail: e.detail });
  }
});

// Upload a file to a row. Raw body upload (no multipart dep):
// POST /api/attachment/:sheet/:rowId
//   headers: X-Filename, Content-Type
//   body: raw file bytes (express.raw below, up to 30mb)
app.post(
  "/api/attachment/:sheet/:rowId",
  express.raw({ type: "*/*", limit: "30mb" }),
  async (req, res) => {
    const sheetId = resolveAttachSheet(req.params.sheet);
    if (!sheetId) return res.status(404).json({ error: `Unknown sheet '${req.params.sheet}'` });
    const rowId = Number(req.params.rowId);
    if (!rowId) return res.status(400).json({ error: "rowId required" });
    const filename = String(req.get("X-Filename") || "upload").replace(/[\r\n"]/g, "_");
    const contentType = req.get("Content-Type") || "application/octet-stream";
    if (!req.body || !req.body.length) return res.status(400).json({ error: "empty body" });
    try {
      // Smartsheet "simple upload": raw bytes + Content-Disposition filename.
      const up = await ssRaw(`/sheets/${sheetId}/rows/${rowId}/attachments`, {
        method: "POST",
        headers: {
          "Content-Type": contentType,
          "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
          "Content-Length": String(req.body.length),
        },
        body: req.body,
      });
      const text = await up.text();
      let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
      if (!up.ok) {
        return res.status(up.status).json({ error: data?.message || `upload failed ${up.status}`, detail: data });
      }
      const a = data.result || {};
      res.json({ ok: true, attachment: { id: a.id, name: a.name, mimeType: a.mimeType || null, sizeInKb: a.sizeInKb ?? null } });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message, detail: e.detail });
    }
  }
);

// Update a single cell (autosave): { rowId, columnId, value, sheetId? }
// Writes always target a SHEET (reports are read-only). sheetId is validated
// against the allowlist (main + case sheets) so arbitrary sheets can't be hit.
const WRITABLE_SHEETS = new Set([String(SHEET_ID), String(OIIG_SHEET_ID), String(FOIA_SHEET_ID)]);
app.put("/api/cell", async (req, res) => {
  const { rowId, columnId, value, sheetId } = req.body || {};
  if (!rowId || !columnId) return res.status(400).json({ error: "rowId and columnId required" });
  const targetSheet = sheetId ? String(sheetId) : String(SHEET_ID);
  if (!WRITABLE_SHEETS.has(targetSheet)) return res.status(403).json({ error: "sheet not writable" });
  try {
    const body = [{
      id: Number(rowId),
      cells: [{ columnId: Number(columnId), value: value === "" ? null : value, strict: false }],
    }];
    const data = await ss(`/sheets/${targetSheet}/rows`, {
      method: "PUT", body: JSON.stringify(body),
    });
    res.json({ ok: true, result: data.result });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, detail: e.detail });
  }
});

// Add a new row: { cells: [{ columnId, value }], sheetId? }
// Defaults to the main sheet; sheetId may target an allowlisted case sheet.
app.post("/api/row", async (req, res) => {
  const { cells, sheetId } = req.body || {};
  const targetSheet = sheetId ? String(sheetId) : String(SHEET_ID);
  if (!WRITABLE_SHEETS.has(targetSheet)) return res.status(403).json({ error: "sheet not writable" });
  try {
    const body = [{
      toBottom: true,
      cells: (cells || []).map(c => ({ columnId: Number(c.columnId), value: c.value, strict: false })),
    }];
    const data = await ss(`/sheets/${targetSheet}/rows`, {
      method: "POST", body: JSON.stringify(body),
    });
    const created = Array.isArray(data.result) ? data.result[0] : data.result;
    res.json({
      ok: true,
      row: created ? {
        rowId: created.id,
        sheetId: Number(targetSheet),
        cells: (created.cells || []).map(cell => ({
          columnId: cell.columnId,
          value: cell.value ?? null,
          displayValue: cell.displayValue ?? null,
        })),
      } : null,
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, detail: e.detail });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CCH Legal backend on :${PORT}`));
