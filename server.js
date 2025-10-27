// server.js – Tourenplan Backend (CRUD + Filter, Excel-Import deaktiviert)
// Laufzeit: Node.js + Express + PostgreSQL (Render)
// Auth: JWT
// Tabellen: fahrer, touren, stopps
//
// Wichtige Änderungen (Oktober 2025):
// - Excel-Import entfällt (deaktiviert). Planung erfolgt über Web-UI.
// - Neue CRUD-Endpunkte für Touren & Stopps
// - Neue Filter-/Gesamtübersicht-Endpunkte
//
// .env (oder Render Env Vars) erwartet:
// - DATABASE_URL (Render Postgres, inkl. SSL)
// - JWT_SECRET
// - PORT (optional)

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import { Pool } from 'pg';

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

// ---------- DB POOL ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ---------- HELPERS ----------
const signToken = (payload) =>
  jwt.sign(payload, process.env.JWT_SECRET || 'dev-secret', { expiresIn: '8h' });

const authFreePaths = new Set(['/login', '/health']);

// JWT Middleware
app.use((req, res, next) => {
  if (authFreePaths.has(req.path)) return next();
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Kein Token' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'dev-secret');
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Ungültiger oder abgelaufener Token' });
  }
});

// ---------- DB SCHEMA (automatisch anlegen) ----------
async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fahrer (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS touren (
      id SERIAL PRIMARY KEY,
      fahrer_id INTEGER NOT NULL REFERENCES fahrer(id) ON DELETE CASCADE,
      datum DATE NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS stopps (
      id SERIAL PRIMARY KEY,
      tour_id INTEGER NOT NULL REFERENCES touren(id) ON DELETE CASCADE,
      kunde TEXT NOT NULL,
      adresse TEXT NOT NULL,
      kommission TEXT,
      hinweis TEXT,
      telefon TEXT,
      status TEXT DEFAULT 'offen',           -- offen | in_bearbeitung | erledigt
      foto_url TEXT,
      ankunft TIMESTAMP NULL,
      position INTEGER
    );
  `);

  // sinnvolle Indizes
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_touren_fahrer_datum ON touren(fahrer_id, datum);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_stopps_tour ON stopps(tour_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_stopps_kunde ON stopps(LOWER(kunde));`);
}

// ---------- AUTH ----------
app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    // Bestehende Zugangsdaten laut Projekt-Notiz
    if (username === 'Gehlenborg' && password === 'Orga1023/') {
      const token = signToken({ user: 'Gehlenborg' });
      return res.json({ token });
    }
    return res.status(401).json({ error: 'Ungültige Zugangsdaten' });
  } catch (e) {
    console.error('Login-Fehler:', e);
    return res.status(500).json({ error: 'Serverfehler' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

// ---------- BESTEHENDE LESENDE ENDPOINTS ----------

// /fahrer – Fahrerliste
app.get('/fahrer', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id, name FROM fahrer ORDER BY name ASC;`);
    res.json(rows);
  } catch (e) {
    console.error('/fahrer Fehler:', e);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

// /touren/:fahrerId/:datum – Tagesdaten eines Fahrers (Tour + Stopps)
app.get('/touren/:fahrerId/:datum', async (req, res) => {
  try {
    const { fahrerId, datum } = req.params;
    const tourRes = await pool.query(
      `SELECT id, fahrer_id, datum FROM touren WHERE fahrer_id=$1 AND datum=$2 LIMIT 1;`,
      [fahrerId, datum]
    );
    if (tourRes.rowCount === 0) {
      return res.json({ tour: null, stopps: [] });
    }
    const tour = tourRes.rows[0];
    const stoppsRes = await pool.query(
      `SELECT id, tour_id, kunde, adresse, kommission, hinweis, telefon, status, foto_url, ankunft, position
       FROM stopps
       WHERE tour_id=$1
       ORDER BY COALESCE(position, 999999), id;`,
      [tour.id]
    );
    res.json({ tour, stopps: stoppsRes.rows });
  } catch (e) {
    console.error('/touren/:fahrerId/:datum Fehler:', e);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

// /touren-woche – einfache Wochenansicht (von/bis)
app.get('/touren-woche', async (req, res) => {
  try {
    const { von, bis, fahrer_id } = req.query;
    const params = [];
    const where = [];
    if (von) { params.push(von); where.push(`datum >= $${params.length}`); }
    if (bis) { params.push(bis); where.push(`datum <= $${params.length}`); }
    if (fahrer_id) { params.push(fahrer_id); where.push(`fahrer_id = $${params.length}`); }
    const sql = `
      SELECT t.id, t.fahrer_id, t.datum, f.name AS fahrer_name,
             COUNT(s.id) AS stopp_count
      FROM touren t
      JOIN fahrer f ON f.id = t.fahrer_id
      LEFT JOIN stopps s ON s.tour_id = t.id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      GROUP BY t.id, f.name
      ORDER BY t.datum ASC, f.name ASC;
    `;
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (e) {
    console.error('/touren-woche Fehler:', e);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

// /reset – Achtung: löscht alle Daten (zu Testzwecken beibehalten)
app.post('/reset', async (_req, res) => {
  try {
    await pool.query('TRUNCATE TABLE stopps RESTART IDENTITY CASCADE;');
    await pool.query('TRUNCATE TABLE touren RESTART IDENTITY CASCADE;');
    // fahrer absichtlich NICHT gelöscht
    res.json({ ok: true });
  } catch (e) {
    console.error('/reset Fehler:', e);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

// ---------- CRUD: TOUREN ----------

// POST /touren – neue Tour anlegen
app.post('/touren', async (req, res) => {
  try {
    const { fahrer_id, datum } = req.body || {};
    if (!fahrer_id || !datum) return res.status(400).json({ error: 'fahrer_id und datum sind erforderlich' });

    // Duplikat vermeiden (eine Tour pro Fahrer/Tag)
    const existing = await pool.query(
      `SELECT id FROM touren WHERE fahrer_id=$1 AND datum=$2 LIMIT 1;`,
      [fahrer_id, datum]
    );
    if (existing.rowCount > 0) {
      return res.status(409).json({ error: 'Tour existiert bereits für Fahrer/Datum', id: existing.rows[0].id });
    }

    const { rows } = await pool.query(
      `INSERT INTO touren (fahrer_id, datum) VALUES ($1, $2) RETURNING id, fahrer_id, datum;`,
      [fahrer_id, datum]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error('POST /touren Fehler:', e);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

// PUT /touren/:id – Tour bearbeiten
app.put('/touren/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const fields = [];
    const values = [];
    const allowed = ['fahrer_id', 'datum'];
    for (const key of allowed) {
      if (key in req.body) {
        values.push(req.body[key]);
        fields.push(`${key} = $${values.length}`);
      }
    }
    if (fields.length === 0) return res.status(400).json({ error: 'Keine Felder zum Aktualisieren' });
    values.push(id);
    const { rows } = await pool.query(
      `UPDATE touren SET ${fields.join(', ')} WHERE id=$${values.length} RETURNING id, fahrer_id, datum;`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'Tour nicht gefunden' });
    res.json(rows[0]);
  } catch (e) {
    console.error('PUT /touren/:id Fehler:', e);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

// DELETE /touren/:id – Tour + Stopps löschen
app.delete('/touren/:id', async (req, res) => {
  try {
    const { id } = req.params;
    // ON DELETE CASCADE auf stopps greift; zur Sicherheit explizit
    await pool.query('DELETE FROM stopps WHERE tour_id=$1;', [id]);
    const result = await pool.query('DELETE FROM touren WHERE id=$1;', [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Tour nicht gefunden' });
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /touren/:id Fehler:', e);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

// GET /touren – Filter (von, bis, fahrer_id, kunde)
app.get('/touren', async (req, res) => {
  try {
    const { von, bis, fahrer_id, kunde } = req.query;
    const params = [];
    const where = [];

    if (von) { params.push(von); where.push(`t.datum >= $${params.length}`); }
    if (bis) { params.push(bis); where.push(`t.datum <= $${params.length}`); }
    if (fahrer_id) { params.push(fahrer_id); where.push(`t.fahrer_id = $${params.length}`); }
    if (kunde) { params.push(`%${String(kunde).toLowerCase()}%`); where.push(`LOWER(s.kunde) LIKE $${params.length}`); }

    const sql = `
      SELECT t.id, t.datum, t.fahrer_id, f.name AS fahrer_name,
             COUNT(s.id) AS stopp_count
      FROM touren t
      JOIN fahrer f ON f.id = t.fahrer_id
      LEFT JOIN stopps s ON s.tour_id = t.id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      GROUP BY t.id, f.name
      ORDER BY t.datum ASC, f.name ASC, t.id ASC;
    `;
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (e) {
    console.error('GET /touren Fehler:', e);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

// ---------- CRUD: STOPPS ----------

// POST /stopps – Stopp anlegen
app.post('/stopps', async (req, res) => {
  try {
    const {
      tour_id, kunde, adresse, kommission = null, hinweis = null, telefon = null,
      status = 'offen', foto_url = null, ankunft = null, position = null
    } = req.body || {};

    if (!tour_id || !kunde || !adresse) {
      return res.status(400).json({ error: 'tour_id, kunde, adresse sind erforderlich' });
    }

    const { rows } = await pool.query(
      `INSERT INTO stopps (tour_id, kunde, adresse, kommission, hinweis, telefon, status, foto_url, ankunft, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id, tour_id, kunde, adresse, kommission, hinweis, telefon, status, foto_url, ankunft, position;`,
      [tour_id, kunde, adresse, kommission, hinweis, telefon, status, foto_url, ankunft, position]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error('POST /stopps Fehler:', e);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

// PUT /stopps/:id – Stopp bearbeiten
app.put('/stopps/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const allowed = ['tour_id', 'kunde', 'adresse', 'kommission', 'hinweis', 'telefon', 'status', 'foto_url', 'ankunft', 'position'];
    const fields = [];
    const values = [];
    for (const key of allowed) {
      if (key in req.body) {
        values.push(req.body[key]);
        fields.push(`${key} = $${values.length}`);
      }
    }
    if (!fields.length) return res.status(400).json({ error: 'Keine Felder zum Aktualisieren' });
    values.push(id);
    const { rows } = await pool.query(
      `UPDATE stopps SET ${fields.join(', ')} WHERE id=$${values.length}
       RETURNING id, tour_id, kunde, adresse, kommission, hinweis, telefon, status, foto_url, ankunft, position;`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'Stopp nicht gefunden' });
    res.json(rows[0]);
  } catch (e) {
    console.error('PUT /stopps/:id Fehler:', e);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

// DELETE /stopps/:id – Stopp löschen
app.delete('/stopps/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const del = await pool.query('DELETE FROM stopps WHERE id=$1;', [id]);
    if (del.rowCount === 0) return res.status(404).json({ error: 'Stopp nicht gefunden' });
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /stopps/:id Fehler:', e);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

// GET /stopps – optional tour_id-Filter
app.get('/stopps', async (req, res) => {
  try {
    const { tour_id } = req.query;
    const params = [];
    let sql = `SELECT id, tour_id, kunde, adresse, kommission, hinweis, telefon, status, foto_url, ankunft, position
               FROM stopps `;
    if (tour_id) {
      params.push(tour_id);
      sql += `WHERE tour_id = $1 `;
    }
    sql += `ORDER BY COALESCE(position, 999999), id;`;
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (e) {
    console.error('GET /stopps Fehler:', e);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

// ---------- FILTER-/GESAMTÜBERSICHT ----------
// GET /uebersicht – paginiert & filterbar
// Query: von, bis, fahrer_id, kunde, page=1, pageSize=50
app.get('/uebersicht', async (req, res) => {
  try {
    const { von, bis, fahrer_id, kunde } = req.query;
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize || '50', 10)));
    const offset = (page - 1) * pageSize;

    const params = [];
    const where = [];
    if (von) { params.push(von); where.push(`t.datum >= $${params.length}`); }
    if (bis) { params.push(bis); where.push(`t.datum <= $${params.length}`); }
    if (fahrer_id) { params.push(fahrer_id); where.push(`t.fahrer_id = $${params.length}`); }
    if (kunde) { params.push(`%${String(kunde).toLowerCase()}%`); where.push(`EXISTS (SELECT 1 FROM stopps sx WHERE sx.tour_id=t.id AND LOWER(sx.kunde) LIKE $${params.length})`); }

    const baseWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // count total
    const countSql = `SELECT COUNT(*)::int AS total FROM touren t ${baseWhere};`;
    const countRes = await pool.query(countSql, params);
    const total = countRes.rows[0]?.total || 0;

    // rows
    const rowsSql = `
      SELECT t.id, t.datum, t.fahrer_id, f.name AS fahrer_name,
             COUNT(s.id) AS stopp_count,
             MIN(s.position) AS first_pos
      FROM touren t
      JOIN fahrer f ON f.id = t.fahrer_id
      LEFT JOIN stopps s ON s.tour_id = t.id
      ${baseWhere}
      GROUP BY t.id, f.name
      ORDER BY t.datum ASC, f.name ASC
      LIMIT ${pageSize} OFFSET ${offset};
    `;
    const listRes = await pool.query(rowsSql, params);

    res.json({
      page, pageSize, total, items: listRes.rows
    });
  } catch (e) {
    console.error('GET /uebersicht Fehler:', e);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

// ---------- (DEAKTIVIERT) EXCEL-IMPORT BEIM START ----------
// Hinweis: Die neue Quelle ist die Web-Planung, daher ist importExcel() deaktiviert.
// Der Code kann später gelöscht werden oder für OneDrive-Import adaptiert werden.
/*
import fs from 'fs';
import path from 'path';
import xlsx from 'xlsx';

async function importExcel() {
  try {
    const filePath = path.join(process.cwd(), 'data', 'Tourenplan.xlsx');
    if (!fs.existsSync(filePath)) {
      console.log('Excel-Datei nicht gefunden – Import übersprungen.');
      return;
    }
    // Hier stand bisher der Import-Parser (ab Zeile 8, Datumszahlen etc.)
    // -> Absichtlich deaktiviert, da Planung nun über Web erfolgt.
    console.log('Excel-Import ist deaktiviert (Zieländerung).');
  } catch (e) {
    console.error('Excel-Import Fehler:', e);
  }
}
*/

// ---------- SERVER START ----------
const PORT = process.env.PORT || 3001;

app.listen(PORT, async () => {
  try {
    await ensureTables();
    console.log(`Tourenplan Backend läuft auf Port ${PORT}`);
    // importExcel(); // deaktiviert
  } catch (e) {
    console.error('Fehler beim Start/ensureTables:', e);
  }
});
