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

// (Optional) einfacher Login, gibt nur das API_TOKEN zurück – kompatibel zu bestehendem Login-Form
app.post("/login", (req, res) => {
  const { username, password } = req.body || {};
  if (username === "Gehlenborg" && password === "Orga1023/") {
    return res.json({ token: process.env.API_TOKEN });
  }
  return res.status(401).json({ error: "Falsche Zugangsdaten" });
});

// --- Datei-Upload (Platzhalter; später OneDrive) ---
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
        fahrer_id INTEGER NOT NULL REFERENCES fahrer(id) ON DELETE CASCADE,
        datum DATE NOT NULL,
        UNIQUE (fahrer_id, datum)
      );

      CREATE TABLE IF NOT EXISTS stopps (
        id SERIAL PRIMARY KEY,
        tour_id INTEGER NOT NULL REFERENCES touren(id) ON DELETE CASCADE,
        kunde TEXT,
        adresse TEXT,
        telefon TEXT,
        hinweis TEXT,
        status TEXT DEFAULT 'offen',
        foto_url TEXT,
        ankunft TIME,
        position INTEGER DEFAULT 0
      );
    `);
    console.log("✅ Tabellen überprüft/erstellt + Constraints gesetzt");
  } catch (err) {
    console.error("❌ Fehler beim Erstellen der Tabellen:", err);
  }
})();

//
// ===== Fahrer =====
//
app.get("/fahrer", auth, async (_req, res) => {
  try {
    const r = await pool.query("SELECT * FROM fahrer ORDER BY name ASC");
    res.json(r.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Fehler beim Laden der Fahrer" });
  }
});

app.post("/fahrer", auth, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: "Name erforderlich" });
    const r = await pool.query(
      "INSERT INTO fahrer (name) VALUES ($1) RETURNING *",
      [name.trim()]
    );
    res.json(r.rows[0]);
  } catch (e) {
    if (e.code === "23505") {
      return res.status(400).json({ error: "Fahrer existiert bereits" });
    }
    console.error(e);
    res.status(500).json({ error: "Fehler beim Hinzufügen des Fahrers" });
  }
});

app.delete("/fahrer/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const r = await pool.query("DELETE FROM fahrer WHERE id=$1", [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: "Fahrer nicht gefunden" });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Fehler beim Löschen des Fahrers" });
  }
});

//
// ===== Planung: Touren + Stopps =====
//

// Tour anlegen (oder bestehende Tour für Fahrer+Datum zurückgeben)
app.post("/touren", auth, async (req, res) => {
  try {
    const { fahrer_id, datum } = req.body || {};
    if (!fahrer_id || !datum) {
      return res.status(400).json({ error: "Fahrer und Datum erforderlich" });
    }
    const r = await pool.query(
      `INSERT INTO touren (fahrer_id, datum)
       VALUES ($1, $2)
       ON CONFLICT (fahrer_id, datum)
       DO UPDATE SET datum = EXCLUDED.datum
       RETURNING *`,
      [Number(fahrer_id), datum]
    );
    console.log(`📅 Tour bereit: Fahrer ${fahrer_id}, Datum ${datum}`);
    res.json(r.rows[0]);
  } catch (e) {
    console.error("❌ Fehler beim Anlegen der Tour:", e);
    res.status(500).json({ error: "Fehler beim Anlegen der Tour" });
  }
});

// Tour + Stopps für Fahrer+Datum laden
app.get("/touren/:fahrerId/:datum", auth, async (req, res) => {
  try {
    const fahrerId = Number(req.params.fahrerId);
    const datum = req.params.datum;
    const t = await pool.query("SELECT * FROM touren WHERE fahrer_id=$1 AND datum=$2", [fahrerId, datum]);
    if (t.rows.length === 0) return res.json({ tour: null, stopps: [] });
    const s = await pool.query(
      "SELECT * FROM stopps WHERE tour_id=$1 ORDER BY position ASC, id ASC",
      [t.rows[0].id]
    );
    res.json({ tour: t.rows[0], stopps: s.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Fehler beim Laden der Tour" });
  }
});

// Stopps einer Tour laden
app.get("/touren/:tourId/stopps", auth, async (req, res) => {
  try {
    const tourId = Number(req.params.tourId);
    const r = await pool.query(
      "SELECT * FROM stopps WHERE tour_id=$1 ORDER BY position ASC, id ASC",
      [tourId]
    );
    res.json(r.rows);
  } catch (e) {
    console.error("❌ Fehler /touren/:tourId/stopps:", e);
    res.status(500).json({ error: "Fehler beim Laden der Stopps" });
  }
});

// Stopp hinzufügen
app.post("/touren/:tourId/stopps", auth, async (req, res) => {
  try {
    const tourId = Number(req.params.tourId);
    const {
      kunde = "",
      adresse = "",
      telefon = "",
      hinweis = "",
      status = "offen",
      ankunft = null,
      position = 0,
    } = req.body || {};

    if (!kunde?.trim() || !adresse?.trim())
      return res.status(400).json({ error: "Kunde und Adresse erforderlich" });

    const r = await pool.query(
      `INSERT INTO stopps (tour_id, kunde, adresse, telefon, hinweis, status, ankunft, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [tourId, kunde.trim(), adresse.trim(), telefon.trim(), hinweis.trim(), status.trim(), ankunft, Number(position) || 0]
    );
    console.log(`📍 Stopp hinzugefügt: Tour ${tourId}, ${kunde}`);
    res.json(r.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Fehler beim Hinzufügen des Stopps" });
  }
});

// Stopp aktualisieren
app.put("/stopps/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const {
      kunde, adresse, telefon, hinweis, status, ankunft, position,
    } = req.body || {};

    const r = await pool.query(
      `UPDATE stopps
         SET kunde = COALESCE($1, kunde),
             adresse = COALESCE($2, adresse),
             telefon = COALESCE($3, telefon),
             hinweis = COALESCE($4, hinweis),
             status  = COALESCE($5, status),
             ankunft = COALESCE($6, ankunft),
             position= COALESCE($7, position)
       WHERE id=$8
       RETURNING *`,
      [kunde, adresse, telefon, hinweis, status, ankunft, (position===''||position===null)? null : Number(position), id]
    );
    res.json(r.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Fehler beim Aktualisieren des Stopps" });
  }
});

// Stopp löschen
app.delete("/stopps/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    await pool.query("DELETE FROM stopps WHERE id=$1", [id]);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Fehler beim Löschen des Stopps" });
  }
});

// Foto-Upload (lokal)
app.post("/stopps/:id/foto", auth, upload.single("foto"), async (req, res) => {
  try {
    const stoppId = Number(req.params.id);
    if (!req.file) return res.status(400).json({ error: "Keine Datei hochgeladen" });
    const fotoUrl = `/uploads/${req.file.filename}`;
    await pool.query("UPDATE stopps SET foto_url=$1 WHERE id=$2", [fotoUrl, stoppId]);
    console.log(`📸 Foto gespeichert für Stopp ${stoppId}`);
    res.json({ success: true, foto_url: fotoUrl });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Fehler beim Foto-Upload" });
  }
});

// (Optional) einfache Tour-Liste (für Debug/Alt)
app.get("/touren", auth, async (_req, res) => {
  try {
    const r = await pool.query(`
      SELECT t.id, t.datum, f.name AS fahrer
      FROM touren t
      JOIN fahrer f ON f.id = t.fahrer_id
      ORDER BY t.datum DESC;
    `);
    res.json(r.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Fehler beim Laden der Touren" });
  }
});

// --- Serverstart ---
app.listen(PORT, () => {
  console.log(`🚀 Tourenplan Backend läuft auf Port ${PORT}`);
});
