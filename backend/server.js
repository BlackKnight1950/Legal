// CCH Legal Team App - Backend proxy
// Holds the Smartsheet API token server-side (env var) and proxies
// read/write calls so the token is NEVER exposed to the browser.
//
// v2: replaces the single shared "gate password" with real per-user
// accounts (email + bcrypt password hash), session cookies (JWT), and
// an audit log of who did what and when.

import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import nodemailer from "nodemailer";
import crypto from "crypto";

const app = express();
app.use(cookieParser());
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

const JWT_SECRET = process.env.JWT_SECRET; // set a long random string in Render env
const APP_BASE_URL = process.env.APP_BASE_URL || "https://blackknight1950.github.io/Legal";
const GMAIL_USER = process.env.GMAIL_USER; // e.g. juliocounty5@gmail.com
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

const USERS_SHEET_ID = process.env.USERS_SHEET_ID || "8684421021650820";
const AUDIT_SHEET_ID = process.env.AUDIT_SHEET_ID || "7881562785009540";

const USER_COLS = {
  email: 4750839228698500,
  name: 2499039415013252,
  passwordHash: 7002639042383748,
  role: 1373139508170628,
  active: 5876739135541124,
  setupToken: 3624939321855876,
  setupTokenExpires: 8128538949226372,
  lastLogin: 810189554749316,
};

const AUDIT_COLS = {
  timestamp: 3749843413274500,
  userEmail: 8253443040644996,
  action: 935093646167940,
  sheet: 5438693273538436,
  rowId: 3186893459853188,
  column: 7690493087223684,
  oldValue: 2060993553010564,
  newValue: 6564593180381060,
};

// Comma-separated list of allowed origins (your GitHub Pages / Render static URL).
const ALLOWED = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
app.use(cors(ALLOWED.length ? { origin: ALLOWED, credentials: true } : { credentials: true }));

if (!SMARTSHEET_TOKEN) console.warn("WARNING: SMARTSHEET_TOKEN is not set.");
if (!JWT_SECRET) console.warn("WARNING: JWT_SECRET is not set — sessions will not be secure.");

const mailer = (GMAIL_USER && GMAIL_APP_PASSWORD)
  ? nodemailer.createTransport({ service: "gmail", auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD } })
  : null;

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

// Sheets whose attachments may be read/written through the proxy.
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

// =====================================================================
// ---- Users sheet helpers ----
// =====================================================================

function cellVal(row, colId) {
  const cell = row.cells.find(c => c.columnId === colId);
  return cell ? (cell.value ?? null) : null;
}

async function getAllUsers() {
  const data = await ss(`/sheets/${USERS_SHEET_ID}`);
  return data.rows.map(r => ({
    rowId: r.id,
    email: cellVal(r, USER_COLS.email),
    name: cellVal(r, USER_COLS.name),
    passwordHash: cellVal(r, USER_COLS.passwordHash),
    role: cellVal(r, USER_COLS.role),
    active: Boolean(cellVal(r, USER_COLS.active)),
    setupToken: cellVal(r, USER_COLS.setupToken),
    setupTokenExpires: cellVal(r, USER_COLS.setupTokenExpires),
  }));
}

async function findUserByEmail(email) {
  const users = await getAllUsers();
  return users.find(u => String(u.email || "").toLowerCase() === String(email || "").toLowerCase()) || null;
}

async function findUserByToken(token) {
  const users = await getAllUsers();
  return users.find(u => u.setupToken && u.setupToken === token) || null;
}

async function addUserRow({ email, name, role }) {
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const body = [{
    toBottom: true,
    cells: [
      { columnId: USER_COLS.email, value: email },
      { columnId: USER_COLS.name, value: name },
      { columnId: USER_COLS.role, value: role || "Staff" },
      { columnId: USER_COLS.active, value: false },
      { columnId: USER_COLS.setupToken, value: token },
      { columnId: USER_COLS.setupTokenExpires, value: expires },
    ],
  }];
  await ss(`/sheets/${USERS_SHEET_ID}/rows`, { method: "POST", body: JSON.stringify(body) });
  return { token, expires };
}

async function updateUserRow(rowId, fields) {
  const cells = [];
  if ("passwordHash" in fields) cells.push({ columnId: USER_COLS.passwordHash, value: fields.passwordHash });
  if ("active" in fields) cells.push({ columnId: USER_COLS.active, value: Boolean(fields.active) });
  if ("setupToken" in fields) cells.push({ columnId: USER_COLS.setupToken, value: fields.setupToken || "" });
  if ("setupTokenExpires" in fields) cells.push({ columnId: USER_COLS.setupTokenExpires, value: fields.setupTokenExpires || "" });
  if ("lastLogin" in fields) cells.push({ columnId: USER_COLS.lastLogin, value: fields.lastLogin });
  if ("role" in fields) cells.push({ columnId: USER_COLS.role, value: fields.role });
  const body = [{ id: Number(rowId), cells }];
  await ss(`/sheets/${USERS_SHEET_ID}/rows`, { method: "PUT", body: JSON.stringify(body) });
}

async function logAudit({ user, action, sheet = "", rowId = "", column = "", oldValue = "", newValue = "" }) {
  try {
    const body = [{
      toBottom: true,
      cells: [
        { columnId: AUDIT_COLS.timestamp, value: new Date().toISOString() },
        { columnId: AUDIT_COLS.userEmail, value: user || "unknown" },
        { columnId: AUDIT_COLS.action, value: action },
        { columnId: AUDIT_COLS.sheet, value: String(sheet) },
        { columnId: AUDIT_COLS.rowId, value: String(rowId) },
        { columnId: AUDIT_COLS.column, value: String(column) },
        { columnId: AUDIT_COLS.oldValue, value: String(oldValue ?? "") },
        { columnId: AUDIT_COLS.newValue, value: String(newValue ?? "") },
      ],
    }];
    await ss(`/sheets/${AUDIT_SHEET_ID}/rows`, { method: "POST", body: JSON.stringify(body) });
  } catch (e) {
    // Audit logging must never break the actual user-facing operation.
    console.error("audit log failed:", e.message);
  }
}

// ---- Auth middleware ----
function requireAuth(req, res, next) {
  const token = req.cookies?.session;
  if (!token) return res.status(401).json({ error: "Not logged in" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Session expired, please log in again" });
  }
}
function requireRole(role) {
  return (req, res, next) => {
    if (req.user?.role !== role) return res.status(403).json({ error: "Forbidden" });
    next();
  };
}

// =====================================================================
// ---- Auth routes ----
// =====================================================================

// Admin invites a new user by email; they get a "set your password" link.
app.post("/api/auth/invite", requireAuth, requireRole("Admin"), async (req, res) => {
  const { email, name, role } = req.body || {};
  if (!email || !name) return res.status(400).json({ error: "email and name required" });
  try {
    const existing = await findUserByEmail(email);
    if (existing) return res.status(409).json({ error: "User already exists" });

    const { token } = await addUserRow({ email, name, role });
    const link = `${APP_BASE_URL}/set-password.html?token=${token}`;

    if (mailer) {
      await mailer.sendMail({
        from: GMAIL_USER,
        to: email,
        subject: "Set up your CCH Legal App account",
        text: `Hi ${name},\n\nYou've been added to the CCH Legal & Risk Management app. Set your password here (link expires in 24 hours):\n\n${link}\n\nIf you weren't expecting this, ignore this email.`,
      });
    } else {
      console.warn("No mailer configured — setup link:", link);
    }
    res.json({ ok: true, link: mailer ? undefined : link }); // surface link if email isn't configured yet
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, detail: e.detail });
  }
});

// User sets their password from the emailed token.
app.post("/api/auth/set-password", async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password || password.length < 8) {
    return res.status(400).json({ error: "Valid token and an 8+ character password are required" });
  }
  try {
    const user = await findUserByToken(token);
    if (!user || new Date(user.setupTokenExpires) < new Date()) {
      return res.status(400).json({ error: "Invalid or expired setup link" });
    }
    const hash = await bcrypt.hash(password, 12);
    await updateUserRow(user.rowId, { passwordHash: hash, active: true, setupToken: "", setupTokenExpires: "" });
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, detail: e.detail });
  }
});

// Login.
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email and password required" });
  try {
    const user = await findUserByEmail(email);
    if (!user || !user.active || !user.passwordHash) {
      await logAudit({ user: email, action: "Login Failed" });
      return res.status(401).json({ error: "Invalid credentials" });
    }
    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      await logAudit({ user: email, action: "Login Failed" });
      return res.status(401).json({ error: "Invalid credentials" });
    }

    await updateUserRow(user.rowId, { lastLogin: new Date().toISOString() });
    await logAudit({ user: email, action: "Login" });

    const token = jwt.sign({ email: user.email, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: "12h" });
    res.cookie("session", token, {
      httpOnly: true, secure: true, sameSite: "none", maxAge: 12 * 3600 * 1000,
    });
    res.json({ ok: true, name: user.name, role: user.role, email: user.email });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, detail: e.detail });
  }
});

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("session");
  res.json({ ok: true });
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({ email: req.user.email, name: req.user.name, role: req.user.role });
});

// ---- Admin views: user list + audit log (Admin role only) ----
app.get("/api/admin/users", requireAuth, requireRole("Admin"), async (_req, res) => {
  try {
    const users = await getAllUsers();
    res.json(users.map(u => ({
      email: u.email, name: u.name, role: u.role, active: u.active, lastLogin: u.lastLogin ?? null,
    }))); // passwordHash and setup tokens intentionally never leave the server
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, detail: e.detail });
  }
});

app.get("/api/admin/audit", requireAuth, requireRole("Admin"), async (_req, res) => {
  try {
    const data = await ss(`/sheets/${AUDIT_SHEET_ID}?rowsModifiedSince=1970-01-01`);
    const rows = data.rows.map(r => ({
      timestamp: cellVal(r, AUDIT_COLS.timestamp),
      userEmail: cellVal(r, AUDIT_COLS.userEmail),
      action: cellVal(r, AUDIT_COLS.action),
      sheet: cellVal(r, AUDIT_COLS.sheet),
      rowId: cellVal(r, AUDIT_COLS.rowId),
      column: cellVal(r, AUDIT_COLS.column),
      oldValue: cellVal(r, AUDIT_COLS.oldValue),
      newValue: cellVal(r, AUDIT_COLS.newValue),
    }));
    rows.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    res.json(rows.slice(0, 200));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, detail: e.detail });
  }
});

// ---- Routes ----

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, sheetId: SHEET_ID, reportId: REPORT_ID, tokenSet: Boolean(SMARTSHEET_TOKEN) });
});

// Everything below this line requires a logged-in session.
app.use("/api", (req, res, next) => {
  if (req.path.startsWith("/auth/") || req.path === "/health") return next();
  return requireAuth(req, res, next);
});

// Report view (read-only source) + real sheet column metadata for write-back.
app.get("/api/report", async (_req, res) => {
  try {
    const sheet = await ss(`/sheets/${SHEET_ID}?level=2`);
    const report = await ss(`/reports/${REPORT_ID}?pageSize=500&include=objectValue`);

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
        columnId: cell.columnId,
        value: cell.value ?? null,
        displayValue: cell.displayValue ?? null,
      })),
    }));

    res.json({ reportId: report.id, reportName: report.name, sheetId: SHEET_ID, permalink: report.permalink, columns, rows });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, detail: e.detail });
  }
});

app.get("/api/sheet", async (_req, res) => {
  try {
    res.json(await fetchSheet(SHEET_ID));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, detail: e.detail });
  }
});

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
function resolveAttachSheet(param) {
  const key = String(param || "").toLowerCase();
  if (EXTRA_SHEETS[key]) return String(EXTRA_SHEETS[key]);
  if (ATTACH_SHEETS.has(String(param))) return String(param);
  return null;
}

app.get("/api/attachments/:sheet", async (req, res) => {
  const sheetId = resolveAttachSheet(req.params.sheet);
  if (!sheetId) return res.status(404).json({ error: `Unknown sheet '${req.params.sheet}'` });
  try {
    const byRow = {};
    let page = 1, totalPages = 1;
    do {
      const data = await ss(`/sheets/${sheetId}/attachments?pageSize=500&page=${page}`);
      (data.data || []).forEach(a => {
        if (a.parentType !== "ROW") return;
        const rid = String(a.parentId);
        (byRow[rid] = byRow[rid] || []).push({
          id: a.id, name: a.name, mimeType: a.mimeType || null, sizeInKb: a.sizeInKb ?? null, createdAt: a.createdAt || null,
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

app.get("/api/attachment-check/:sheet/:attachmentId", async (req, res) => {
  const sheetId = resolveAttachSheet(req.params.sheet);
  if (!sheetId) return res.status(404).json({ error: `Unknown sheet '${req.params.sheet}'` });
  const attId = Number(req.params.attachmentId);
  if (!attId) return res.status(400).json({ error: "attachmentId required" });
  const out = { sheetId, attId, tokenSet: Boolean(SMARTSHEET_TOKEN) };
  try {
    const meta = await ss(`/sheets/${sheetId}/attachments/${attId}`);
    out.meta = { name: meta.name, mimeType: meta.mimeType, sizeInKb: meta.sizeInKb, hasUrl: Boolean(meta.url), urlExpiresInMillis: meta.urlExpiresInMillis };
    if (meta.url) {
      const t0 = Date.now();
      try {
        const f = await fetch(meta.url, { method: "GET" });
        const bytes = f.ok ? (await f.arrayBuffer()).byteLength : 0;
        out.storage = { reachable: true, status: f.status, bytes, ms: Date.now() - t0, sizeInKbImplied: bytes ? Math.round(bytes / 1024) : null };
      } catch (fe) {
        out.storage = { reachable: false, error: fe.message };
      }
    }
    res.json(out);
  } catch (e) {
    out.error = e.message; out.detail = e.detail;
    res.status(e.status || 500).json(out);
  }
});

app.get("/api/attachment/:sheet/:attachmentId", async (req, res) => {
  const sheetId = resolveAttachSheet(req.params.sheet);
  if (!sheetId) return res.status(404).json({ error: `Unknown sheet '${req.params.sheet}'` });
  const attId = Number(req.params.attachmentId);
  if (!attId) return res.status(400).json({ error: "attachmentId required" });
  try {
    const meta = await ss(`/sheets/${sheetId}/attachments/${attId}`);
    if (!meta.url) return res.status(404).json({ error: "attachment has no download url" });
    let fileRes;
    try {
      fileRes = await fetch(meta.url);
    } catch (fe) {
      return res.status(502).json({ error: `couldn't reach file storage: ${fe.message}` });
    }
    if (!fileRes.ok) return res.status(fileRes.status).json({ error: `storage returned ${fileRes.status}` });
    const name = (meta.name || "attachment").replace(/["\\\r\n]/g, "_");
    const buf = Buffer.from(await fileRes.arrayBuffer());
    res.setHeader("Content-Type", meta.mimeType || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    res.setHeader("Content-Length", buf.length);
    res.end(buf);
    logAudit({ user: req.user.email, action: "Attachment Downloaded", sheet: sheetId, rowId: "", column: meta.name });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, detail: e.detail });
  }
});

app.post(
  "/api/attachment/:sheet/:rowId",
  requireAuth,
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
      if (!up.ok) return res.status(up.status).json({ error: data?.message || `upload failed ${up.status}`, detail: data });
      const a = data.result || {};
      await logAudit({ user: req.user.email, action: "Attachment Uploaded", sheet: sheetId, rowId, column: a.name });
      res.json({ ok: true, attachment: { id: a.id, name: a.name, mimeType: a.mimeType || null, sizeInKb: a.sizeInKb ?? null } });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message, detail: e.detail });
    }
  }
);

// Update a single cell (autosave): { rowId, columnId, value, sheetId? }
const WRITABLE_SHEETS = new Set([String(SHEET_ID), String(OIIG_SHEET_ID), String(FOIA_SHEET_ID)]);
app.put("/api/cell", async (req, res) => {
  const { rowId, columnId, value, sheetId } = req.body || {};
  if (!rowId || !columnId) return res.status(400).json({ error: "rowId and columnId required" });
  const targetSheet = sheetId ? String(sheetId) : String(SHEET_ID);
  if (!WRITABLE_SHEETS.has(targetSheet)) return res.status(403).json({ error: "sheet not writable" });
  try {
    // Grab the old value first so the audit trail shows before/after.
    let oldValue = "";
    try {
      const before = await ss(`/sheets/${targetSheet}/rows/${rowId}`);
      const cell = before.cells.find(c => c.columnId === Number(columnId));
      oldValue = cell?.value ?? "";
    } catch { /* non-fatal — proceed without old value */ }

    const body = [{
      id: Number(rowId),
      cells: [{ columnId: Number(columnId), value: value === "" ? null : value, strict: false }],
    }];
    const data = await ss(`/sheets/${targetSheet}/rows`, { method: "PUT", body: JSON.stringify(body) });

    await logAudit({
      user: req.user.email, action: "Cell Edit", sheet: targetSheet, rowId, column: columnId,
      oldValue, newValue: value,
    });
    res.json({ ok: true, result: data.result });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, detail: e.detail });
  }
});

// Add a new row: { cells: [{ columnId, value }], sheetId? }
app.post("/api/row", async (req, res) => {
  const { cells, sheetId } = req.body || {};
  const targetSheet = sheetId ? String(sheetId) : String(SHEET_ID);
  if (!WRITABLE_SHEETS.has(targetSheet)) return res.status(403).json({ error: "sheet not writable" });
  try {
    const body = [{
      toBottom: true,
      cells: (cells || []).map(c => ({ columnId: Number(c.columnId), value: c.value, strict: false })),
    }];
    const data = await ss(`/sheets/${targetSheet}/rows`, { method: "POST", body: JSON.stringify(body) });
    const created = Array.isArray(data.result) ? data.result[0] : data.result;

    await logAudit({ user: req.user.email, action: "Row Added", sheet: targetSheet, rowId: created?.id });

    res.json({
      ok: true,
      row: created ? {
        rowId: created.id,
        sheetId: Number(targetSheet),
        cells: (created.cells || []).map(cell => ({
          columnId: cell.columnId, value: cell.value ?? null, displayValue: cell.displayValue ?? null,
        })),
      } : null,
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, detail: e.detail });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CCH Legal backend on :${PORT}`));
