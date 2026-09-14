// Run this ONCE, locally, to create the very first Admin account.
// After that, use the in-app "Invite user" flow for everyone else.
//
// Usage:
//   SMARTSHEET_TOKEN=xxx node scripts/seed-admin.js jablis@cookcountyhhs.org "Julius Ablis" "yourTempPassword123"
//
// Change the temp password immediately after your first login if you want,
// there's no "force reset" flow — it's your account, your call.

import bcrypt from "bcrypt";

const SMARTSHEET_TOKEN = process.env.SMARTSHEET_TOKEN;
const USERS_SHEET_ID = process.env.USERS_SHEET_ID || "8684421021650820";
const SS_BASE = "https://api.smartsheet.com/2.0";

const USER_COLS = {
  email: 4750839228698500,
  name: 2499039415013252,
  passwordHash: 7002639042383748,
  role: 1373139508170628,
  active: 5876739135541124,
};

const [, , email, name, password] = process.argv;
if (!email || !name || !password) {
  console.error('Usage: node seed-admin.js <email> "<name>" <password>');
  process.exit(1);
}
if (!SMARTSHEET_TOKEN) {
  console.error("Set SMARTSHEET_TOKEN in your environment first.");
  process.exit(1);
}

const hash = await bcrypt.hash(password, 12);

const res = await fetch(`${SS_BASE}/sheets/${USERS_SHEET_ID}/rows`, {
  method: "POST",
  headers: { Authorization: `Bearer ${SMARTSHEET_TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify([{
    toBottom: true,
    cells: [
      { columnId: USER_COLS.email, value: email },
      { columnId: USER_COLS.name, value: name },
      { columnId: USER_COLS.passwordHash, value: hash },
      { columnId: USER_COLS.role, value: "Admin" },
      { columnId: USER_COLS.active, value: true },
    ],
  }]),
});

const data = await res.json();
if (!res.ok) {
  console.error("Failed:", data);
  process.exit(1);
}
console.log(`Admin account created for ${email}. Go log in.`);
