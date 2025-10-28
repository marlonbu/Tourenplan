import express from "express";
import pg from "pg";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 10000;

// --- PostgreSQL-Verbindung ---
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// --- Middleware ---
app.use(cors());
app.use(express.json());
app.use("/uploads", express.static("uploads"));

// --- Auth Middleware ---
const auth = (req, res, next) => {
  const token = req.headers.authorization;
  if (!token || token !== `Bearer ${process.env.API_TOKEN}`) {
    return res.status(403).json({ error: "Nicht autorisiert" });
  }
  next();
};

// --- Datei-Upload Setup (für spätere OneDrive-Anbindung) ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) =>
    cb(null, `${Date.now()}-${file.originalname.replace(/\s+/g, "_")}`),
});
const upload = multer({ storage });

// --- Tabellen erstellen ---
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
        datum DATE NOT NULL,
        UNIQUE (fahrer_id, datum)
      );

      CREATE TABLE IF NOT EXISTS stopps (
        id SERIAL PRIMARY KEY,
        tour_id INTEGER REFERENCES touren(id) ON DELETE CASCADE,
        kunde TEXT,
        adresse TEXT,
        telefon TEXT,
        hinweis TEXT,
        status TEXT DEFAULT 'offen',
        foto_url TEXT,
        ankunft TIMESTAMP,
        position INTEGER
      );
    `);
    console.log("✅ Tabellen überprüft/erstellt + Constraints gesetzt");
  } catch (err) {
    console.error("❌ Fehler beim Erstellen der Tabellen:", err);
  }
})();

// --- Fahrer abrufen ---
app.get("/fahrer", auth, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM fahrer ORDER BY name ASC");
    res.json(result.rows);
  } catch (err) {
    console.error("Fehler beim Laden der Fahrer:", err);
    res.status(500).json({ error: "Fehler beim Laden der Fahrer" });
  }
});

// --- Fahrer hinzufügen ---
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
    if (err.code === "23505") {
      res.status(400).json({ error: "Fahrer existiert bereits" });
    } else {
      console.error("Fehler beim Hinzufügen des Fahrers:", err);
      res.status(500).json({ error: "Fehler beim Hinzufügen des Fahrers" });
    }
  }
});

// --- Fahrer löschen ---
app.delete("/fahrer/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const result = await pool.query("DELETE FROM fahrer WHERE id = $1", [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Fahrer nicht gefunden" });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("Fehler beim Löschen des Fahrers:", err);
    res.status(500).json({ error: "Fehler beim Löschen des Fahrers" });
  }
});

// --- Tour anlegen ---
app.post("/touren", auth, async (req, res) => {
  try {
    const { fahrer_id, datum } = req.body;
    if (!fahrer_id || !datum) {
      return res.status(400).json({ error: "Fahrer und Datum erforderlich" });
    }

    const result = await pool.query(
      `INSERT INTO touren (fahrer_id, datum)
       VALUES ($1, $2)
       ON CONFLICT (fahrer_id, datum)
       DO UPDATE SET datum = EXCLUDED.datum
       RETURNING *`,
      [fahrer_id, datum]
    );

    console.log(`📅 Tour angelegt: Fahrer ${fahrer_id}, Datum ${datum}`);
    res.json(result.rows[0]);
  } catch (err) {
    console.error("❌ Fehler beim Anlegen der Tour:", err);
    res.status(500).json({ error: "Fehler beim Anlegen der Tour" });
  }
});

// --- Stopps hinzufügen ---
app.post("/stopps", auth, async (req, res) => {
  try {
    const { tour_id, kunde, adresse, telefon, hinweis, position } = req.body;
    if (!tour_id || !kunde) {
      return res.status(400).json({ error: "Tour und Kunde erforderlich" });
    }

    const result = await pool.query(
      `INSERT INTO stopps (tour_id, kunde, adresse, telefon, hinweis, position)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [tour_id, kunde, adresse, telefon, hinweis, position || 1]
    );

    console.log(`📍 Neuer Stopp für Tour ${tour_id}: ${kunde}`);
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Fehler beim Hinzufügen des Stopps:", err);
    res.status(500).json({ error: "Fehler beim Hinzufügen des Stopps" });
  }
});

// --- Foto-Upload (Platzhalter, später OneDrive) ---
app.post("/stopps/:id/foto", auth, upload.single("foto"), async (req, res) => {
  try {
    const stoppId = req.params.id;
    const fotoUrl = `/uploads/${req.file.filename}`;
    await pool.query("UPDATE stopps SET foto_url = $1 WHERE id = $2", [
      fotoUrl,
      stoppId,
    ]);
    console.log(`📸 Foto gespeichert für Stopp ${stoppId}`);
    res.json({ success: true, foto_url: fotoUrl });
  } catch (err) {
    console.error("Fehler beim Upload:", err);
    res.status(500).json({ error: "Fehler beim Foto-Upload" });
  }
});

// --- Touren abrufen (alle) ---
app.get("/touren", auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT t.id, t.datum, f.name AS fahrer
      FROM touren t
      JOIN fahrer f ON f.id = t.fahrer_id
      ORDER BY t.datum DESC;
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("Fehler beim Laden der Touren:", err);
    res.status(500).json({ error: "Fehler beim Laden der Touren" });
  }
});

// --- Tourdetails abrufen ---
app.get("/touren/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const result = await pool.query(
      `
      SELECT s.*, t.datum, f.name AS fahrer_name
      FROM stopps s
      JOIN touren t ON s.tour_id = t.id
      JOIN fahrer f ON f.id = t.fahrer_id
      WHERE s.tour_id = $1
      ORDER BY s.position ASC;
      `,
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Fehler beim Laden der Tourdetails:", err);
    res.status(500).json({ error: "Fehler beim Laden der Tourdetails" });
  }
});

// --- Gesamtübersicht mit Filtern ---
app.get("/touren-gesamt", auth, async (req, res) => {
  try {
    const fahrerId = req.query.fahrerId ? Number(req.query.fahrerId) : null;
    const from = req.query.from || null;
    const to = req.query.to || null;
    const kunde = req.query.kunde ? `%${req.query.kunde}%` : null;

    console.log("📊 Filter geprüft:", { fahrerId, from, to, kunde });

    const query = `
      SELECT
        t.id AS tour_id,
        t.datum,
        f.id AS fahrer_id,
        f.name AS fahrer_name,
        COUNT(s.id) AS stopp_count,
        ARRAY_AGG(s.kunde) FILTER (WHERE s.kunde IS NOT NULL) AS kunden
      FROM touren t
      JOIN fahrer f ON f.id = t.fahrer_id
      LEFT JOIN stopps s ON s.tour_id = t.id
      WHERE
        ($1::int IS NULL OR t.fahrer_id = $1)
        AND ($2::date IS NULL OR t.datum >= $2)
        AND ($3::date IS NULL OR t.datum <= $3)
        AND ($4::text IS NULL OR s.kunde ILIKE $4)
      GROUP BY t.id, f.id, f.name
      ORDER BY t.datum DESC, f.name ASC;
    `;

    const result = await pool.query(query, [fahrerId, from, to, kunde]);
    res.json(
      result.rows.map((r) => ({
        id: r.tour_id,
        datum: r.datum,
        fahrer: { id: r.fahrer_id, name: r.fahrer_name },
        stopp_count: Number(r.stopp_count) || 0,
        kunden: r.kunden?.filter(Boolean) || [],
      }))
    );
  } catch (err) {
    console.error("❌ Fehler /touren-gesamt:", err);
    res.status(500).json({ error: "Fehler beim Laden der Gesamtübersicht" });
  }
});

// --- Wochenansicht (Platzhalter für spätere Erweiterung) ---
app.get("/touren-woche", auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT f.name AS fahrer, t.datum, COUNT(s.id) AS stopps
      FROM touren t
      JOIN fahrer f ON f.id = t.fahrer_id
      LEFT JOIN stopps s ON s.tour_id = t.id
      GROUP BY f.name, t.datum
      ORDER BY t.datum DESC;
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("Fehler bei /touren-woche:", err);
    res.status(500).json({ error: "Fehler bei der Wochenansicht" });
  }
});

// --- Serverstart ---
app.listen(PORT, () => {
  console.log(`🚀 Tourenplan Backend läuft auf Port ${PORT}`);
});
