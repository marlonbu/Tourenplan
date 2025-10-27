// server.js – Tourenplan Backend (CRUD + Filter, Excel-Import deaktiviert)
// Laufzeit: Node.js + Express + PostgreSQL (Render / lokal)
// Auth: JWT
// Tabellen: fahrer, touren, stopps
//
// Oktober 2025:
// - Excel-Import entfällt (deaktiviert). Planung erfolgt über Web-UI.
// - Neue CRUD-Endpunkte für Touren & Stopps
// - Neue Filter-/Gesamtübersicht-Endpunkte
//
// ENV-Vars (Render oder lokal):
// - DATABASE_URL
// - JWT_SECRET
// - PORT (optional)

// Falls du lokal eine .env verwendest, diese Zeile aktivieren:
// import 'dotenv/config';

import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import { Pool } from 'pg';

// ---------- SETUP ----------
const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

// ---------- DB POOL ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// ---------- HELPER ----------
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
  } catch {
    return res.status(401).json({ error: 'Ungültiger oder abgelaufener Token' });
  }
});

// ---------- DB SCHEMA ----------
async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fahrer (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );
  `);

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
      status TEXT DEFAULT 'offen',
      foto_url TEXT,
      ankunft TIMESTAMP NULL,
      position INTEGER
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_touren_fahrer_datum ON touren(fahrer_id, datum);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_stopps_tour ON stopps(tour_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_stopps_kunde ON stopps(LOWER(kunde));`);

  console.log('✅ Tabellen überprüft/erstellt');
}

// ---------- AUTH ----------
app.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === 'Gehlenborg' && password === 'Orga1023/') {
    const token = signToken({ user: username });
    return res.json({ token });
  }
  res.status(401).json({ error: 'Ungültige Zugangsdaten' });
});

app.get('/health', (_, res) => res.json({ ok: true }));

// ---------- FAHRER ----------
app.get('/fahrer', async (_, res) => {
  try {
    const { rows } = await pool.query('SELECT id, name FROM fahrer ORDER BY name ASC;');
    res.json(rows);
  } catch (err) {
    console.error('/fahrer Fehler:', err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

// ---------- TOUR LESEN ----------
app.get('/touren/:fahrerId/:datum', async (req, res) => {
  try {
    const { fahrerId, datum } = req.params;
    const tourRes = await pool.query(
      'SELECT id, fahrer_id, datum FROM touren WHERE fahrer_id=$1 AND datum=$2 LIMIT 1;',
      [fahrerId, datum]
    );
    if (tourRes.rowCount === 0) return res.json({ tour: null, stopps: [] });

    const tour = tourRes.rows[0];
    const stoppsRes = await pool.query(
      `SELECT * FROM stopps WHERE tour_id=$1 ORDER BY COALESCE(position, 999999), id;`,
      [tour.id]
    );
    res.json({ tour, stopps: stoppsRes.rows });
  } catch (err) {
    console.error('/touren/:fahrerId/:datum Fehler:', err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

// ---------- TOUR CRUD ----------
app.post('/touren', async (req, res) => {
  try {
    const { fahrer_id, datum } = req.body || {};
    if (!fahrer_id || !datum)
      return res.status(400).json({ error: 'fahrer_id und datum sind erforderlich' });

    const existing = await pool.query(
      'SELECT id FROM touren WHERE fahrer_id=$1 AND datum=$2 LIMIT 1;',
      [fahrer_id, datum]
    );
    if (existing.rowCount > 0)
      return res
        .status(409)
        .json({ error: 'Tour existiert bereits', id: existing.rows[0].id });

    const { rows } = await pool.query(
      'INSERT INTO touren (fahrer_id, datum) VALUES ($1, $2) RETURNING *;',
      [fahrer_id, datum]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST /touren Fehler:', err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

app.put('/touren/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { fahrer_id, datum } = req.body;
    const { rows } = await pool.query(
      'UPDATE touren SET fahrer_id=$1, datum=$2 WHERE id=$3 RETURNING *;',
      [fahrer_id, datum, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Tour nicht gefunden' });
    res.json(rows[0]);
  } catch (err) {
    console.error('PUT /touren/:id Fehler:', err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

app.delete('/touren/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM stopps WHERE tour_id=$1;', [id]);
    const del = await pool.query('DELETE FROM touren WHERE id=$1;', [id]);
    if (!del.rowCount) return res.status(404).json({ error: 'Tour nicht gefunden' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /touren/:id Fehler:', err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

// ---------- STOPPS CRUD ----------
app.post('/stopps', async (req, res) => {
  try {
    const {
      tour_id,
      kunde,
      adresse,
      kommission = null,
      hinweis = null,
      telefon = null,
      status = 'offen',
      foto_url = null,
      ankunft = null,
      position = null,
    } = req.body || {};

    if (!tour_id || !kunde || !adresse)
      return res.status(400).json({ error: 'tour_id, kunde, adresse erforderlich' });

    const { rows } = await pool.query(
      `INSERT INTO stopps (tour_id, kunde, adresse, kommission, hinweis, telefon, status, foto_url, ankunft, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *;`,
      [tour_id, kunde, adresse, kommission, hinweis, telefon, status, foto_url, ankunft, position]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST /stopps Fehler:', err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

app.put('/stopps/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const allowed = [
      'tour_id',
      'kunde',
      'adresse',
      'kommission',
      'hinweis',
      'telefon',
      'status',
      'foto_url',
      'ankunft',
      'position',
    ];
    const updates = [];
    const values = [];
    for (const key of allowed) {
      if (key in req.body) {
        updates.push(`${key}=$${updates.length + 1}`);
        values.push(req.body[key]);
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'Keine Felder zum Aktualisieren' });
    values.push(id);
    const { rows } = await pool.query(
      `UPDATE stopps SET ${updates.join(', ')} WHERE id=$${values.length} RETURNING *;`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'Stopp nicht gefunden' });
    res.json(rows[0]);
  } catch (err) {
    console.error('PUT /stopps/:id Fehler:', err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

app.delete('/stopps/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const del = await pool.query('DELETE FROM stopps WHERE id=$1;', [id]);
    if (!del.rowCount) return res.status(404).json({ error: 'Stopp nicht gefunden' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /stopps/:id Fehler:', err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

// ---------- ÜBERSICHT / FILTER ----------
app.get('/uebersicht', async (req, res) => {
  try {
    const { von, bis, fahrer_id, kunde } = req.query;
    const params = [];
    const where = [];

    if (von) {
      params.push(von);
      where.push(`t.datum >= $${params.length}`);
    }
    if (bis) {
      params.push(bis);
      where.push(`t.datum <= $${params.length}`);
    }
    if (fahrer_id) {
      params.push(fahrer_id);
      where.push(`t.fahrer_id = $${params.length}`);
    }
    if (kunde) {
      params.push(`%${kunde.toLowerCase()}%`);
      where.push(
        `EXISTS (SELECT 1 FROM stopps s WHERE s.tour_id=t.id AND LOWER(s.kunde) LIKE $${params.length})`
      );
    }

    const sql = `
      SELECT t.id, t.datum, f.name AS fahrer_name,
             COUNT(s.id) AS stopps_count
      FROM touren t
      JOIN fahrer f ON f.id=t.fahrer_id
      LEFT JOIN stopps s ON s.tour_id=t.id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      GROUP BY t.id, f.name
      ORDER BY t.datum ASC, f.name ASC;
    `;
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('GET /uebersicht Fehler:', err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

// ---------- RESET ----------
app.post('/reset', async (_, res) => {
  try {
    await pool.query('TRUNCATE stopps, touren RESTART IDENTITY CASCADE;');
    res.json({ ok: true });
  } catch (err) {
    console.error('/reset Fehler:', err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

// ---------- ROOT ----------
app.get('/', (_, res) => {
  res.send('✅ Tourenplan Backend läuft (CRUD + Filter aktiv)');
});

// ---------- START ----------
const PORT = process.env.PORT || 3001;

app.listen(PORT, async () => {
  try {
    await ensureTables();
    console.log(`🚀 Tourenplan Backend läuft auf Port ${PORT}`);
  } catch (err) {
    console.error('Fehler beim Start:', err);
  }
});
