// server.js — Express + PostgreSQL + stabile JWT-Auth (optional deaktivierbar)
// Node ≥ 18, ESM aktiv

import express from "express";
import cors from "cors";
import pg from "pg";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import multer from "multer";
import fs from "fs";
import path from "path";

dotenv.config();

const app = express();
const port = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// --------- Uploads-Verzeichnis ----------
if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");
app.use("/uploads", express.static("uploads"));

// --------- Multer (lokale Ablage – OneDrive später) ----------
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, "uploads/"),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/\s+/g, "_");
    cb(null, `${Date.now()}-${safe}`);
  },
});
const upload = multer({ storage });

// --------- PostgreSQL ----------
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// --------- Auth (JWT + optional deaktivierbar + Legacy-Token) ----------
const JWT_SECRET = process.env.JWT_SECRET || "change-me-in-render";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";
// Dev-Token nur wenn explizit gesetzt:
const ALLOW_DEV_TOKEN = process.env.ALLOW_DEV_TOKEN === "true";

const auth = (req, _res, next) => {
  if (process.env.DISABLE_AUTH === "true") return next();

  const header = req.headers.authorization || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (ALLOW_DEV_TOKEN && (header === "Gehlenborg" || bearer === "Gehlenborg")) {
    req.user = { sub: "Gehlenborg", name: "Gehlenborg", role: "legacy" };
    return next();
  }

  if (!bearer) return next({ status: 401, message: "Kein Token" });

  try {
    const payload = jwt.verify(bearer, JWT_SECRET);
    req.user = payload;
    return next();
  } catch {
    return next({ status: 401, message: "Ungültiger oder abgelaufener Token" });
  }
};

// DEV-Login: POST /login -> { token }
app.post("/login", (req, res) => {
  const { username, password } = req.body || {};
  const ok = username === "Gehlenborg" && password === "Orga1023/";
  if (!ok) return res.status(401).json({ error: "Login fehlgeschlagen" });

  const payload = { sub: username, name: "Gehlenborg", role: "admin" };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  return res.json({ token });
});

// --------- Tabellen prüfen/erstellen ----------
(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fahrer (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS touren (
      id SERIAL PRIMARY KEY,
      fahrer_id INT REFERENCES fahrer(id) ON DELETE CASCADE,
      datum DATE NOT NULL,
      bemerkung TEXT
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stopps (
      id SERIAL PRIMARY KEY,
      tour_id INT REFERENCES touren(id) ON DELETE CASCADE,
      kunde TEXT,
      adresse TEXT,
      telefon TEXT,
      kommission TEXT,
      hinweis TEXT,
      position INT,
      foto_url TEXT
    );
  `);
  await pool.query(`
    ALTER TABLE stopps
    ADD COLUMN IF NOT EXISTS anmerkung_fahrer TEXT DEFAULT NULL;
  `);
  console.log("✅ Tabellen bereit (inkl. anmerkung_fahrer)");
})().catch((e) => console.error("❌ DB-Init Fehler:", e));

// --------- Debug/Service ----------
app.get("/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.get("/whoami", (req, res) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const isLegacyDevToken = header === "Gehlenborg" || token === "Gehlenborg";

  let decoded = null;
  let validJwt = false;
  if (token) {
    try {
      decoded = jwt.verify(token, JWT_SECRET);
      validJwt = true;
    } catch {
      validJwt = false;
    }
  }

  res.json({
    authDisabled: process.env.DISABLE_AUTH === "true",
    allowDevToken: ALLOW_DEV_TOKEN,
    hasAuthHeader: Boolean(header),
    isLegacyDevToken,
    validJwt,
    user: decoded
      ? { sub: decoded.sub, name: decoded.name, role: decoded.role, exp: decoded.exp }
      : isLegacyDevToken
      ? { sub: "Gehlenborg", name: "Gehlenborg", role: "legacy" }
      : null,
  });
});

// ============================================================
// ========== FAHRER ==========================================
// ============================================================
app.get("/fahrer", auth, async (_req, res) => {
  try {
    const r = await pool.query("SELECT * FROM fahrer ORDER BY id ASC");
    res.json(r.rows);
  } catch (e) {
    console.error("❌ /fahrer GET:", e.message);
    res.status(500).json({ error: "Fehler beim Laden der Fahrer" });
  }
});

app.post("/fahrer", auth, async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: "Name erforderlich" });
  try {
    const r = await pool.query("INSERT INTO fahrer (name) VALUES ($1) RETURNING *", [name]);
    res.json(r.rows[0]);
  } catch (e) {
    console.error("❌ /fahrer POST:", e.message);
    res.status(500).json({ error: "Fehler beim Hinzufügen des Fahrers" });
  }
});

app.delete("/fahrer/:id", auth, async (req, res) => {
  try {
    await pool.query("DELETE FROM fahrer WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error("❌ /fahrer DELETE:", e.message);
    res.status(500).json({ error: "Fehler beim Löschen des Fahrers" });
  }
});

// ============================================================
// ========== TOUREN ==========================================
// ============================================================
app.post("/touren", auth, async (req, res) => {
  const { fahrer_id, datum } = req.body || {};
  if (!fahrer_id || !datum)
    return res.status(400).json({ error: "Fahrer & Datum erforderlich" });
  try {
    const r = await pool.query(
      "INSERT INTO touren (fahrer_id, datum) VALUES ($1,$2) RETURNING *",
      [fahrer_id, datum]
    );
    res.json(r.rows[0]);
  } catch (e) {
    console.error("❌ /touren POST:", e.message);
    res.status(500).json({ error: "Fehler beim Anlegen der Tour" });
  }
});

app.get("/touren/:fahrer_id/:datum", auth, async (req, res) => {
  try {
    const { fahrer_id, datum } = req.params;
    const t = await pool.query("SELECT * FROM touren WHERE fahrer_id=$1 AND datum=$2", [
      fahrer_id,
      datum,
    ]);
    if (t.rows.length === 0) return res.json({ tour: null, stopps: [] });
    const tour = t.rows[0];
    const s = await pool.query(
      "SELECT * FROM stopps WHERE tour_id=$1 ORDER BY COALESCE(position, 2147483647) ASC, id ASC",
      [tour.id]
    );
    res.json({ tour, stopps: s.rows });
  } catch (e) {
    console.error("❌ /touren/:fahrer_id/:datum GET:", e.message);
    res.status(500).json({ error: "Fehler beim Laden der Tour" });
  }
});

// Admin-Liste: Touren (mit Filtern)
function isoWeekToRange(kwStr) {
  const m = /^(\d{4})-W(\d{2})$/.exec(kwStr || "");
  if (!m) return null;
  const year = Number(m[1]);
  const week = Number(m[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const mondayOfWeek1 = new Date(jan4);
  mondayOfWeek1.setUTCDate(jan4.getUTCDate() - (jan4Day - 1));
  const monday = new Date(mondayOfWeek1);
  monday.setUTCDate(mondayOfWeek1.getUTCDate() + (week - 1) * 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const toIso = (d) => d.toISOString().slice(0, 10);
  return { start: toIso(monday), end: toIso(sunday) };
}

app.get("/touren-admin", auth, async (req, res) => {
  try {
    const { fahrer_id, date_from, date_to, kw, kunde } = req.query;

    const where = [];
    const params = [];
    let p = 1;

    if (fahrer_id) { where.push(`t.fahrer_id = $${p++}`); params.push(fahrer_id); }
    if (date_from) { where.push(`t.datum >= $${p++}`); params.push(date_from); }
    if (date_to) { where.push(`t.datum <= $${p++}`); params.push(date_to); }
    if (kw && !date_from && !date_to) {
      const r = isoWeekToRange(kw);
      if (r) { where.push(`t.datum BETWEEN $${p++} AND $${p++}`); params.push(r.start, r.end); }
    }
    if (kunde) {
      where.push(`EXISTS (SELECT 1 FROM stopps s2 WHERE s2.tour_id = t.id AND s2.kunde ILIKE $${p++})`);
      params.push(`%${kunde}%`);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const sql = `
      SELECT
        t.id, t.datum, t.fahrer_id, t.bemerkung,
        f.name AS fahrer_name,
        COUNT(s.id) AS stopps_count,
        COALESCE(array_to_string((array_agg(s.kunde ORDER BY COALESCE(s.position, 2147483647) ASC))[1:3], ', '), '') AS kunden_preview
      FROM touren t
      JOIN fahrer f ON f.id = t.fahrer_id
      LEFT JOIN stopps s ON s.tour_id = t.id
      ${whereSql}
      GROUP BY t.id, f.id
      ORDER BY t.datum ASC, f.name ASC, t.id ASC
      LIMIT 2000
    `;
    const r = await pool.query(sql, params);
    res.json(r.rows);
  } catch (e) {
    console.error("❌ /touren-admin GET:", e.message);
    res.status(500).json({ error: "Fehler beim Laden der Touren (Admin)" });
  }
});

// ============================================================
// ========== STOPPS ==========================================
// ============================================================

// A) Stopps einer Tour – robust & mit Klartext-Fehlern
app.get("/touren/:id/stopps", auth, async (req, res) => {
  try {
    // 1) ID prüfen
    const idStr = (req.params.id || "").trim();
    const id = Number(idStr);
    if (!idStr || !Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Ungültige Tour-ID" });
    }

    // 2) Tour existiert?
    const tour = await pool.query("SELECT id FROM touren WHERE id=$1", [id]);
    if (tour.rows.length === 0) {
      return res.status(404).json({ error: "Tour nicht gefunden" });
    }

    // 3) Stopps laden
    const r = await pool.query(
      "SELECT * FROM stopps s WHERE s.tour_id=$1 ORDER BY COALESCE(s.position, 2147483647) ASC, s.id ASC",
      [id]
    );

    return res.json(r.rows);
  } catch (e) {
    // Log + echte DB-Fehlermeldung an Client zurückgeben (hilft bei 500)
    console.error("❌ /touren/:id/stopps GET:", e.message);
    return res.status(500).json({ error: e.message || "Fehler beim Laden der Stopps" });
  }
});

// B) Stopp anlegen
app.post("/stopps/:tour_id", auth, async (req, res) => {
  const { tour_id } = req.params;
  const {
    kunde = null,
    adresse = null,
    telefon = null,
    kommission = null,
    hinweis = null,
    position = null,
  } = req.body || {};

  try {
    const r = await pool.query(
      `INSERT INTO stopps (tour_id, kunde, adresse, telefon, kommission, hinweis, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [tour_id, kunde, adresse, telefon, kommission, hinweis, position]
    );
    res.json(r.rows[0]);
  } catch (e) {
    console.error("❌ /stopps/:tour_id POST:", e.message);
    res.status(500).json({ error: "Fehler beim Hinzufügen des Stopps" });
  }
});

// C) Stopp bearbeiten (alle Felder)
app.patch("/stopps/:id", auth, async (req, res) => {
  try {
    const { kunde, adresse, telefon, kommission, hinweis, position, anmerkung_fahrer } = req.body || {};
    const sets = [];
    const params = [];
    let p = 1;
    if (kunde !== undefined) { sets.push(`kunde=$${p++}`); params.push(kunde); }
    if (adresse !== undefined) { sets.push(`adresse=$${p++}`); params.push(adresse); }
    if (telefon !== undefined) { sets.push(`telefon=$${p++}`); params.push(telefon); }
    if (kommission !== undefined) { sets.push(`kommission=$${p++}`); params.push(kommission); }
    if (hinweis !== undefined) { sets.push(`hinweis=$${p++}`); params.push(hinweis); }
    if (position !== undefined) { sets.push(`position=$${p++}`); params.push(position); }
    if (anmerkung_fahrer !== undefined) { sets.push(`anmerkung_fahrer=$${p++}`); params.push(anmerkung_fahrer); }
    if (sets.length === 0) return res.status(400).json({ error: "Keine Änderungen übergeben" });

    params.push(req.params.id);
    const sql = `UPDATE stopps SET ${sets.join(", ")} WHERE id=$${p} RETURNING *`;
    const r = await pool.query(sql, params);
    if (r.rows.length === 0) return res.status(404).json({ error: "Stopp nicht gefunden" });
    res.json(r.rows[0]);
  } catch (e) {
    console.error("❌ /stopps/:id PATCH:", e.message);
    res.status(500).json({ error: "Fehler beim Aktualisieren des Stopps" });
  }
});

// D) Nur „Anmerkung Fahrer“ separat (von deinem Frontend genutzt)
app.patch("/stopps/:id/anmerkung", auth, async (req, res) => {
  try {
    const { anmerkung_fahrer } = req.body || {};
    const r = await pool.query(
      "UPDATE stopps SET anmerkung_fahrer=$1 WHERE id=$2 RETURNING *",
      [anmerkung_fahrer ?? null, req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: "Stopp nicht gefunden" });
    res.json(r.rows[0]);
  } catch (e) {
    console.error("❌ /stopps/:id/anmerkung PATCH:", e.message);
    res.status(500).json({ error: "Fehler beim Speichern der Anmerkung" });
  }
});

// E) Stopp löschen
app.delete("/stopps/:id", auth, async (req, res) => {
  try {
    await pool.query("DELETE FROM stopps WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error("❌ /stopps/:id DELETE:", e.message);
    res.status(500).json({ error: "Fehler beim Löschen des Stopps" });
  }
});

// ============================================================
// ========== FOTO ============================================
// ============================================================
app.post("/stopps/:id/foto", auth, upload.single("foto"), async (req, res) => {
  try {
    const stoppId = req.params.id;
    const file = req.file;
    if (!file) return res.status(400).json({ error: "Kein Foto empfangen" });

    const publicUrl = `${req.protocol}://${req.get("host")}/uploads/${file.filename}`;
    const r = await pool.query("UPDATE stopps SET foto_url=$1 WHERE id=$2 RETURNING *", [
      publicUrl,
      stoppId,
    ]);
    if (r.rows.length === 0) return res.status(404).json({ error: "Stopp nicht gefunden" });
    res.json(r.rows[0]);
  } catch (e) {
    console.error("❌ Foto-Upload:", e.message);
    res.status(500).json({ error: "Fehler beim Foto-Upload" });
  }
});

app.delete("/stopps/:id/foto", auth, async (req, res) => {
  try {
    const stoppId = req.params.id;
    const cur = await pool.query("SELECT foto_url FROM stopps WHERE id=$1", [stoppId]);
    const url = cur.rows[0]?.foto_url;

    if (url) {
      const filename = path.basename(url);
      const filePath = path.join("uploads", filename);
      if (fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch {}
      }
    }

    const r = await pool.query("UPDATE stopps SET foto_url=NULL WHERE id=$1 RETURNING *", [stoppId]);
    if (r.rows.length === 0) return res.status(404).json({ error: "Stopp nicht gefunden" });
    res.json(r.rows[0]);
  } catch (e) {
    console.error("❌ Foto-Löschen:", e.message);
    res.status(500).json({ error: "Fehler beim Foto-Löschen" });
  }
});

// --------- Debug ----------
app.get("/touren-debug", async (_req, res) => {
  const r = await pool.query("SELECT * FROM touren ORDER BY id DESC");
  res.json(r.rows);
});

// --------- Fehlerhandler ----------
app.use((err, _req, res, _next) => {
  const status = err?.status || 500;
  const message = err?.message || "Serverfehler";
  res.status(status).json({ error: message });
});

// --------- Start ----------
app.listen(port, () => {
  console.log(`🚀 Tourenplan Backend läuft auf Port ${port}`);
});
