import express from "express";
import bodyParser from "body-parser";
import pg from "pg";
import cors from "cors";
import jwt from "jsonwebtoken";

const { Pool } = pg;
const app = express();
app.use(bodyParser.json());
app.use(cors());

// 🔐 Konfiguration
const JWT_SECRET = process.env.JWT_SECRET || "meinGeheimesToken";
const PORT = process.env.PORT || 10000;

// Render/Heroku-typische DB-Config
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false,
});

// --- Kleine Helper ---
const withClient = async (fn) => {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
};

const auth = (req, res, next) => {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Kein Token" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Ungültiger Token" });
  }
};

// --- DB Setup & Migration ---
async function ensureSchema() {
  await withClient(async (c) => {
    // fahrer
    await c.query(`
      CREATE TABLE IF NOT EXISTS fahrer (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL
      );
    `);

    // fahrzeuge
    await c.query(`
      CREATE TABLE IF NOT EXISTS fahrzeuge (
        id SERIAL PRIMARY KEY,
        kennzeichen TEXT NOT NULL
      );
    `);

    // touren
    await c.query(`
      CREATE TABLE IF NOT EXISTS touren (
        id SERIAL PRIMARY KEY,
        fahrer_id INTEGER NOT NULL REFERENCES fahrer(id) ON DELETE CASCADE,
        fahrzeug_id INTEGER REFERENCES fahrzeuge(id) ON DELETE SET NULL,
        datum DATE NOT NULL
      );
    `);

    // stopps – enthält jetzt: telefon, hinweis, status
    await c.query(`
      CREATE TABLE IF NOT EXISTS stopps (
        id SERIAL PRIMARY KEY,
        tour_id INTEGER NOT NULL REFERENCES touren(id) ON DELETE CASCADE,
        adresse TEXT NOT NULL,
        lat DOUBLE PRECISION,
        lng DOUBLE PRECISION,
        reihenfolge INTEGER NOT NULL,
        kunde TEXT,
        kommission TEXT,
        telefon TEXT,     -- ✅ neu
        hinweis TEXT,     -- ✅ ersetzt "anmerkung"
        status TEXT       -- ✅ neu (vom Fahrer beschreibbar)
      );
    `);

    // Indizes für Performance
    await c.query(`CREATE INDEX IF NOT EXISTS idx_touren_fahrer_datum ON touren(fahrer_id, datum);`);
    await c.query(`CREATE INDEX IF NOT EXISTS idx_stopps_tour_ordnung ON stopps(tour_id, reihenfolge);`);

    // 🔁 Migration: falls alte Spalte "anmerkung" existiert -> nach "hinweis" umbenennen
    const colCheck = await c.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'stopps' AND column_name IN ('anmerkung','hinweis','telefon','status')
    `);
    const cols = colCheck.rows.map(r => r.column_name);

    if (cols.includes("anmerkung") && !cols.includes("hinweis")) {
      await c.query(`ALTER TABLE stopps RENAME COLUMN anmerkung TO hinweis;`);
    }

    // Falls Spalten fehlen (z. B. ältere Deploys), ergänzen
    const refreshCols = (await c.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'stopps'
    `)).rows.map(r => r.column_name);

    if (!refreshCols.includes("telefon")) {
      await c.query(`ALTER TABLE stopps ADD COLUMN telefon TEXT;`);
    }
    if (!refreshCols.includes("hinweis")) {
      await c.query(`ALTER TABLE stopps ADD COLUMN hinweis TEXT;`);
    }
    if (!refreshCols.includes("status")) {
      await c.query(`ALTER TABLE stopps ADD COLUMN status TEXT;`);
    }
  });
}

// --- Auth ---
/**
 * POST /login
 * Body: { username, password }
 * Demo-Login gemäß Vorgabe:
 *   Benutzername: Gehlenborg
 *   Passwort: Orga1023/
 */
app.post("/login", async (req, res) => {
  const { username, password } = req.body || {};
  const validUser = (username === "Gehlenborg" && password === "Orga1023/");
  if (!validUser) return res.status(401).json({ error: "Login fehlgeschlagen" });

  const token = jwt.sign(
    { u: "Gehlenborg", r: "admin" },
    JWT_SECRET,
    { expiresIn: "7d" } // Token-Lebensdauer; Auto-Logout kann später verkürzt werden
  );
  res.json({ token });
});

// --- API ---
app.get("/health", (_, res) => res.json({ ok: true }));

// Liste aller Fahrer
app.get("/fahrer", auth, async (_, res) => {
  try {
    const result = await withClient((c) => c.query(`SELECT id, name FROM fahrer ORDER BY name;`));
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: "Fehler bei /fahrer", details: e.message });
  }
});

/**
 * GET /touren/:fahrerId/:datum
 * Liefert Tour + Stopps inkl. telefon, hinweis, status
 * datum-Format: YYYY-MM-DD
 */
app.get("/touren/:fahrerId/:datum", auth, async (req, res) => {
  const { fahrerId, datum } = req.params;
  try {
    const tour = await withClient((c) =>
      c.query(
        `SELECT t.id, t.fahrer_id, t.fahrzeug_id, t.datum,
                f.name AS fahrer_name, vz.kennzeichen
         FROM touren t
         JOIN fahrer f ON f.id = t.fahrer_id
         LEFT JOIN fahrzeuge vz ON vz.id = t.fahrzeug_id
         WHERE t.fahrer_id = $1 AND t.datum = $2
         LIMIT 1`,
        [fahrerId, datum]
      )
    );

    if (tour.rowCount === 0) {
      return res.json({ tour: null, stopps: [] });
    }

    const tourId = tour.rows[0].id;
    const stopps = await withClient((c) =>
      c.query(
        `SELECT id, tour_id, adresse, lat, lng, reihenfolge, kunde, kommission, telefon, hinweis, status
         FROM stopps
         WHERE tour_id = $1
         ORDER BY reihenfolge ASC`,
        [tourId]
      )
    );

    res.json({ tour: tour.rows[0], stopps: stopps.rows });
  } catch (e) {
    res.status(500).json({ error: "Fehler bei /touren/:fahrerId/:datum", details: e.message });
  }
});

/**
 * PATCH /stopps/:stoppId
 * Body: { status?, hinweis?, telefon? }
 * Ermöglicht das beschreibbare Statusfeld (und optional Telefon/Hinweis-Anpassung)
 */
app.patch("/stopps/:stoppId", auth, async (req, res) => {
  const { stoppId } = req.params;
  const { status, hinweis, telefon } = req.body || {};

  const fields = [];
  const values = [];
  let idx = 1;

  if (typeof status !== "undefined") {
    fields.push(`status = $${idx++}`);
    values.push(status);
  }
  if (typeof hinweis !== "undefined") {
    fields.push(`hinweis = $${idx++}`);
    values.push(hinweis);
  }
  if (typeof telefon !== "undefined") {
    fields.push(`telefon = $${idx++}`);
    values.push(telefon);
  }

  if (fields.length === 0) {
    return res.status(400).json({ error: "Keine Felder übergeben" });
  }

  values.push(stoppId);

  try {
    const q = `UPDATE stopps SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *;`;
    const result = await withClient((c) => c.query(q, values));
    if (result.rowCount === 0) return res.status(404).json({ error: "Stopp nicht gefunden" });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: "Fehler bei PATCH /stopps/:stoppId", details: e.message });
  }
});

/**
 * POST /reset
 * Leert Tabellen (Reihenfolge wegen FK)
 */
app.post("/reset", auth, async (_, res) => {
  try {
    await withClient(async (c) => {
      await c.query("TRUNCATE stopps RESTART IDENTITY CASCADE;");
      await c.query("TRUNCATE touren RESTART IDENTITY CASCADE;");
      await c.query("TRUNCATE fahrzeuge RESTART IDENTITY CASCADE;");
      await c.query("TRUNCATE fahrer RESTART IDENTITY CASCADE;");
    });
    res.json({ message: "✅ Tabellen geleert" });
  } catch (e) {
    res.status(500).json({ error: "Fehler bei /reset", details: e.message });
  }
});

/**
 * POST /seed-demo
 * Erstellt Demodaten für Fahrer "Christoph Arlt" (Lindern ↔ Oldenburg)
 * mit neuen Spalten: telefon, hinweis, status
 */
app.post("/seed-demo", auth, async (_, res) => {
  try {
    const { fahrerId, fahrzeugId, tourId } = await withClient(async (c) => {
      // Fahrer
      const f = await c.query(
        `INSERT INTO fahrer(name)
         VALUES ($1)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        ["Christoph Arlt"]
      );
      const finalFahrerId = f.rowCount ? f.rows[0].id : (await c.query(`SELECT id FROM fahrer WHERE name=$1`, ["Christoph Arlt"])).rows[0].id;

      // Fahrzeug
      const v = await c.query(
        `INSERT INTO fahrzeuge(kennzeichen)
         VALUES ($1)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        ["CLP-CA 300"]
      );
      const finalFahrzeugId = v.rowCount ? v.rows[0].id : (await c.query(`SELECT id FROM fahrzeuge WHERE kennzeichen=$1`, ["CLP-CA 300"])).rows[0].id;

      // Tour (heute)
      const today = new Date().toISOString().slice(0, 10);
      const t = await c.query(
        `INSERT INTO touren(fahrer_id, fahrzeug_id, datum)
         VALUES ($1,$2,$3)
         RETURNING id`,
        [finalFahrerId, finalFahrzeugId, today]
      );
      const finalTourId = t.rows[0].id;

      // Stopps
      await c.query(
        `INSERT INTO stopps (tour_id, adresse, lat, lng, reihenfolge, kunde, kommission, telefon, hinweis, status)
         VALUES
         ($1,'Mühlenstraße 10, 49699 Lindern',52.8470,7.7692,1,'Kunde A','KOM-1001','0151 1234567','Anlieferung EG',''),
         ($1,'Cloppenburger Str. 1, 49661 Cloppenburg',52.8479,8.0476,2,'Kunde B','KOM-1002','0173 1234567','Hintereingang nutzen',''),
         ($1,'Staulinie 10, 26122 Oldenburg',53.1410,8.2150,3,'Kunde C','KOM-1003','0441 123456','Bitte anrufen bei Ankunft','')`,
        [finalTourId]
      );

      return { fahrerId: finalFahrerId, fahrzeugId: finalFahrzeugId, tourId: finalTourId };
    });

    res.json({ message: "✅ Demodaten eingefügt", fahrerId, fahrzeugId, tourId });
  } catch (e) {
    res.status(500).json({ error: "Fehler bei /seed-demo", details: e.message });
  }
});

// --- Serverstart ---
ensureSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`🚀 API läuft auf Port ${PORT}`));
  })
  .catch((e) => {
    console.error("DB-Initialisierung fehlgeschlagen:", e);
    process.exit(1);
  });
