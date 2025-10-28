import express from "express";
import pg from "pg";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 10000;

// PostgreSQL-Verbindung
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Middleware
app.use(cors());
app.use(express.json());

// --- Middleware zur einfachen Authentifizierung ---
const auth = (req, res, next) => {
  const token = req.headers.authorization;
  if (!token || token !== `Bearer ${process.env.API_TOKEN}`) {
    return res.status(403).json({ error: "Nicht autorisiert" });
  }
  next();
};

// --- Tabellen erstellen, falls nicht vorhanden ---
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fahrer (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL
      );

      CREATE TABLE IF NOT EXISTS touren (
        id SERIAL PRIMARY KEY,
        fahrer_id INTEGER REFERENCES fahrer(id) ON DELETE CASCADE,
        datum DATE NOT NULL
      );

      CREATE TABLE IF NOT EXISTS stopps (
        id SERIAL PRIMARY KEY,
        tour_id INTEGER REFERENCES touren(id) ON DELETE CASCADE,
        kunde TEXT,
        adresse TEXT,
        telefon TEXT,
        reihenfolge INTEGER,
        erledigt BOOLEAN DEFAULT false
      );
    `);

    // Constraint setzen, um doppelte Touren (fahrer_id + datum) zu verhindern
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'unique_fahrer_datum'
        ) THEN
          ALTER TABLE touren
          ADD CONSTRAINT unique_fahrer_datum UNIQUE (fahrer_id, datum);
        END IF;
      END
      $$;
    `);

    console.log("✅ Tabellen überprüft/erstellt + Constraint gesetzt");
  } catch (err) {
    console.error("❌ Fehler beim Tabellenerstellen:", err);
  }
})();

// --- ROUTES ---

// Fahrer abrufen
app.get("/fahrer", auth, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM fahrer ORDER BY name ASC");
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Fehler beim Laden der Fahrer" });
  }
});

// Fahrer hinzufügen
app.post("/fahrer", auth, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Name darf nicht leer sein" });
    }
    const result = await pool.query(
      "INSERT INTO fahrer (name) VALUES ($1) RETURNING *",
      [name.trim()]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === "23505") {
      res.status(400).json({ error: "Fahrer existiert bereits" });
    } else {
      res.status(500).json({ error: "Fehler beim Hinzufügen des Fahrers" });
    }
  }
});

// Fahrer löschen
app.delete("/fahrer/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const result = await pool.query("DELETE FROM fahrer WHERE id=$1", [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Fahrer nicht gefunden" });
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Fehler beim Löschen des Fahrers" });
  }
});

// Tour anlegen
app.post("/touren", auth, async (req, res) => {
  try {
    const { fahrer_id, datum } = req.body;
    if (!fahrer_id || !datum) {
      return res.status(400).json({ error: "Fahrer und Datum erforderlich" });
    }
    const result = await pool.query(
      "INSERT INTO touren (fahrer_id, datum) VALUES ($1, $2) ON CONFLICT (fahrer_id, datum) DO UPDATE SET datum = EXCLUDED.datum RETURNING *",
      [fahrer_id, datum]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Fehler beim Anlegen der Tour" });
  }
});

// Alle Touren abrufen
app.get("/touren", auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.id, t.datum, f.name AS fahrer
       FROM touren t
       JOIN fahrer f ON f.id = t.fahrer_id
       ORDER BY t.datum DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Fehler beim Laden der Touren" });
  }
});

// Tourdetails (Stopps)
app.get("/touren/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const result = await pool.query(
      `SELECT s.*, t.datum, f.name AS fahrer_name
       FROM stopps s
       JOIN touren t ON s.tour_id = t.id
       JOIN fahrer f ON f.id = t.fahrer_id
       WHERE s.tour_id = $1
       ORDER BY s.reihenfolge ASC`,
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Fehler beim Laden der Tourdetails" });
  }
});

// --- Gesamtübersicht (mit Filtern) ---
app.get("/touren-gesamt", auth, async (req, res) => {
  try {
    const fahrerId = req.query.fahrerId ? Number(req.query.fahrerId) : null;
    const from =
      req.query.from && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from)
        ? req.query.from
        : null;
    const to =
      req.query.to && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to)
        ? req.query.to
        : null;
    const kunde = req.query.kunde?.trim() || null;

    console.log("📊 Filter geprüft:", { fahrerId, from, to, kunde });

    const sql = `
      SELECT
        t.id,
        t.datum,
        t.fahrer_id,
        f.name AS fahrer_name,
        COUNT(s.id) AS stopp_count,
        COALESCE((
          SELECT ARRAY(
            SELECT DISTINCT s2.kunde
            FROM stopps s2
            WHERE s2.tour_id = t.id AND s2.kunde IS NOT NULL
            ORDER BY s2.kunde
            LIMIT 10
          )
        ), '{}') AS kunden
      FROM touren t
      JOIN fahrer f ON f.id = t.fahrer_id
      LEFT JOIN stopps s ON s.tour_id = t.id
      WHERE
        ($1::integer IS NULL OR t.fahrer_id = $1::integer)
        AND ($2::date IS NULL OR t.datum >= $2::date)
        AND ($3::date IS NULL OR t.datum <= $3::date)
        AND ($4::text IS NULL OR EXISTS (
          SELECT 1 FROM stopps sx
          WHERE sx.tour_id = t.id AND sx.kunde ILIKE ('%' || $4 || '%')
        ))
      GROUP BY t.id, f.name
      ORDER BY t.datum DESC, f.name ASC;
    `;

    const result = await pool.query(sql, [fahrerId, from, to, kunde]);

    res.json(
      result.rows.map((r) => ({
        id: r.id,
        datum: r.datum,
        fahrer: { id: r.fahrer_id, name: r.fahrer_name },
        stopp_count: Number(r.stopp_count || 0),
        kunden: r.kunden || [],
      }))
    );
  } catch (err) {
    console.error("❌ Fehler /touren-gesamt:", err);
    res
      .status(500)
      .json({ error: "Fehler beim Laden der Gesamtübersicht", details: err });
  }
});

// --- Serverstart ---
app.listen(PORT, () => {
  console.log(`🚀 Tourenplan Backend läuft auf Port ${PORT}`);
});
