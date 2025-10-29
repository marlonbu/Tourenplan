import express from "express";
import cors from "cors";
import pkg from "pg";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import bodyParser from "body-parser";
import multer from "multer";
import fs from "fs";
import path from "path";

dotenv.config();
const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json());
app.use(bodyParser.json());

// ============================================================
// Upload-Ordner vorbereiten & statisch ausliefern
// ============================================================
const UPLOAD_DIR = "uploads";
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}
app.use("/uploads", express.static(UPLOAD_DIR));

// Multer-Setup (lokale Speicherung, später OneDrive möglich)
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const stoppId = req.params.stoppId || "unknown";
    const ext = path.extname(file.originalname || ".jpg").toLowerCase() || ".jpg";
    const ts = Date.now();
    cb(null, `stopp_${stoppId}_${ts}${ext}`);
  },
});
const upload = multer({ storage });

// ============================================================
// Datenbankverbindung
// ============================================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
});

// ============================================================
// Tabellen anlegen / prüfen
// ============================================================
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fahrer (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS touren (
      id SERIAL PRIMARY KEY,
      fahrer_id INTEGER NOT NULL REFERENCES fahrer(id),
      datum TIMESTAMPTZ NOT NULL,
      UNIQUE (fahrer_id, datum)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS stopps (
      id SERIAL PRIMARY KEY,
      tour_id INTEGER NOT NULL REFERENCES touren(id) ON DELETE CASCADE,
      kunde TEXT,
      adresse TEXT,
      kommission TEXT,
      hinweis TEXT,
      telefon TEXT,
      status TEXT DEFAULT 'offen',
      foto_url TEXT,
      ankunft TEXT,
      position INTEGER DEFAULT 0
    );
  `);

  // Sicherstellen, dass FK auf Fahrer CASCADE löscht
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'touren_fahrer_id_fkey'
          AND table_name = 'touren'
      ) THEN
        ALTER TABLE touren DROP CONSTRAINT touren_fahrer_id_fkey;
      END IF;
    END $$;
  `);

  await pool.query(`
    ALTER TABLE touren
    ADD CONSTRAINT touren_fahrer_id_fkey
    FOREIGN KEY (fahrer_id) REFERENCES fahrer(id) ON DELETE CASCADE;
  `);

  console.log("✅ Tabellen überprüft/erstellt + Cascade aktiv");
}
initDB().catch((e) => console.error("❌ initDB Fehler:", e));

// ============================================================
// Authentifizierung
// ============================================================
const JWT_SECRET = process.env.JWT_SECRET || "orga_secret";

function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: "Kein Token" });
  const token = header.split(" ")[1];
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Ungültiger Token" });
  }
}

app.post("/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (username === "Gehlenborg" && password === "Orga1023/") {
    const token = jwt.sign({ user: username }, JWT_SECRET, { expiresIn: "12h" });
    return res.json({ token });
  }
  return res.status(401).json({ error: "Ungültige Anmeldedaten" });
});

// ============================================================
// Fahrer-Routen
// ============================================================

// Alle Fahrer
app.get("/fahrer", auth, async (_req, res) => {
  try {
    const r = await pool.query("SELECT * FROM fahrer ORDER BY name ASC");
    res.json(r.rows);
  } catch (e) {
    console.error("❌ Fehler beim Laden der Fahrer:", e);
    res.status(500).json({ error: "Fehler beim Laden der Fahrer" });
  }
});

// Fahrer hinzufügen
app.post("/fahrer", auth, async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: "Name erforderlich" });

    const r = await pool.query(
      "INSERT INTO fahrer (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING *",
      [name.trim()]
    );
    if (r.rows.length === 0) return res.json({ message: "Fahrer bereits vorhanden" });
    console.log("✅ Fahrer hinzugefügt:", r.rows[0]);
    res.json(r.rows[0]);
  } catch (e) {
    console.error("❌ Fehler beim Hinzufügen des Fahrers:", e);
    res.status(500).json({ error: "Fehler beim Hinzufügen des Fahrers" });
  }
});

// Fahrer löschen
app.delete("/fahrer/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    await pool.query("DELETE FROM fahrer WHERE id=$1", [id]);
    console.log("🗑️ Fahrer gelöscht:", id);
    res.json({ success: true });
  } catch (e) {
    console.error("❌ Fehler beim Löschen des Fahrers:", e);
    res.status(500).json({ error: "Fehler beim Löschen des Fahrers" });
  }
});

// Optional: mehrere Fahrer hinzufügen (Seed)
app.post("/fahrer/seed", auth, async (req, res) => {
  try {
    const { namen } = req.body || {};
    if (!Array.isArray(namen) || namen.length === 0)
      return res.status(400).json({ error: "namen: [] erforderlich" });

    const values = namen.map((n) => `('${n.replace(/'/g, "''")}')`).join(",");
    const sql =
      "INSERT INTO fahrer (name) VALUES " +
      values +
      " ON CONFLICT (name) DO NOTHING RETURNING *";
    const r = await pool.query(sql);
    console.log(`✅ Fahrer-Seed: ${r.rows.length} neu hinzugefügt`);
    res.json({ added: r.rows.length, rows: r.rows });
  } catch (e) {
    console.error("❌ Seed-Fehler:", e);
    res.status(500).json({ error: "Fehler beim Seed" });
  }
});

// ============================================================
// Touren-Routen
// ============================================================

// Tour anlegen oder aktualisieren
app.post("/touren", auth, async (req, res) => {
  try {
    const { fahrer_id, datum } = req.body || {};
    if (!fahrer_id || !datum)
      return res.status(400).json({ error: "Fahrer und Datum erforderlich" });

    const exists = await pool.query(
      "SELECT id FROM touren WHERE fahrer_id=$1 AND datum::date=$2::date",
      [Number(fahrer_id), datum]
    );

    let result;
    if (exists.rows.length > 0) {
      result = await pool.query(
        "UPDATE touren SET datum=$2::timestamptz WHERE fahrer_id=$1 RETURNING *",
        [Number(fahrer_id), datum]
      );
    } else {
      result = await pool.query(
        "INSERT INTO touren (fahrer_id, datum) VALUES ($1, $2::timestamptz) RETURNING *",
        [Number(fahrer_id), datum]
      );
    }

    console.log("📅 Tour bereitgestellt:", result.rows[0]);
    res.json(result.rows[0]);
  } catch (e) {
    console.error("❌ Fehler beim Anlegen der Tour:", e);
    res.status(500).json({ error: "Fehler beim Anlegen der Tour" });
  }
});

// Tour laden mit Datumsnormalisierung
app.get("/touren/:fahrerId/:datum", auth, async (req, res) => {
  try {
    const fahrerId = Number(req.params.fahrerId);
    let datum = req.params.datum;

    // Normalisierung: DD.MM.YYYY -> YYYY-MM-DD
    if (datum.includes(".")) {
      const [d, m, y] = datum.split(".");
      datum = `${y}-${m}-${d}`;
    }

    console.log("🔍 Lade Tour:", { fahrerId, datum });

    const tourResult = await pool.query(
      "SELECT * FROM touren WHERE fahrer_id=$1 AND datum::date=$2::date",
      [fahrerId, datum]
    );

    if (tourResult.rows.length === 0) {
      console.log("ℹ️ Keine Tour gefunden.");
      return res.json({ tour: null, stopps: [] });
    }

    const tour = tourResult.rows[0];
    const stoppsResult = await pool.query(
      "SELECT * FROM stopps WHERE tour_id=$1 ORDER BY position ASC, id ASC",
      [tour.id]
    );

    res.json({ tour, stopps: stoppsResult.rows });
  } catch (e) {
    console.error("❌ Fehler beim Laden der Tour:", e);
    res.status(500).json({ error: "Fehler beim Laden der Tour" });
  }
});

// ============================================================
// Stopps-Routen (CRUD + Foto-Upload)
// ============================================================

// Stopp hinzufügen
app.post("/stopps/:tourId", auth, async (req, res) => {
  try {
    const tourId = Number(req.params.tourId);
    const {
      kunde = "",
      adresse = "",
      kommission = "",
      hinweis = "",
      telefon = "",
      status = "offen",
      foto_url = "",
      ankunft = "",
      position = 0,
    } = req.body || {};

    if (!tourId) return res.status(400).json({ error: "tourId erforderlich" });
    if (!kunde || !adresse) return res.status(400).json({ error: "Kunde & Adresse erforderlich" });

    const r = await pool.query(
      `INSERT INTO stopps
       (tour_id, kunde, adresse, kommission, hinweis, telefon, status, foto_url, ankunft, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [tourId, kunde, adresse, kommission, hinweis, telefon, status, foto_url, ankunft, position ?? 0]
    );

    console.log("➕ Stopp hinzugefügt:", r.rows[0]);
    res.json(r.rows[0]);
  } catch (e) {
    console.error("❌ Fehler beim Hinzufügen des Stopps:", e);
    res.status(500).json({ error: "Fehler beim Hinzufügen des Stopps" });
  }
});

// Stopp löschen
app.delete("/stopps/:stoppId", auth, async (req, res) => {
  try {
    const stoppId = Number(req.params.stoppId);

    // ggf. altes Foto löschen
    const old = await pool.query("SELECT foto_url FROM stopps WHERE id=$1", [stoppId]);
    const oldUrl = old.rows?.[0]?.foto_url;
    if (oldUrl && oldUrl.startsWith("/uploads/")) {
      const p = path.join(".", oldUrl);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }

    await pool.query("DELETE FROM stopps WHERE id=$1", [stoppId]);
    console.log("🗑️ Stopp gelöscht:", stoppId);
    res.json({ success: true });
  } catch (e) {
    console.error("❌ Fehler beim Löschen des Stopps:", e);
    res.status(500).json({ error: "Fehler beim Löschen des Stopps" });
  }
});

// Stopp bearbeiten
app.put("/stopps/:stoppId", auth, async (req, res) => {
  try {
    const stoppId = Number(req.params.stoppId);
    const {
      kunde, adresse, kommission, hinweis, telefon,
      status, foto_url, ankunft, position
    } = req.body || {};

    const r = await pool.query(
      `UPDATE stopps
       SET kunde = COALESCE($2, kunde),
           adresse = COALESCE($3, adresse),
           kommission = COALESCE($4, kommission),
           hinweis = COALESCE($5, hinweis),
           telefon = COALESCE($6, telefon),
           status = COALESCE($7, status),
           foto_url = COALESCE($8, foto_url),
           ankunft = COALESCE($9, ankunft),
           position = COALESCE($10, position)
       WHERE id=$1
       RETURNING *`,
      [stoppId, kunde, adresse, kommission, hinweis, telefon, status, foto_url, ankunft, position]
    );

    res.json(r.rows[0]);
  } catch (e) {
    console.error("❌ Fehler beim Bearbeiten des Stopps:", e);
    res.status(500).json({ error: "Fehler beim Bearbeiten des Stopps" });
  }
});

// Foto hochladen
app.post("/stopps/:stoppId/foto", auth, upload.single("foto"), async (req, res) => {
  try {
    const stoppId = Number(req.params.stoppId);
    if (!req.file) return res.status(400).json({ error: "Datei fehlt (Form-Feldname: foto)" });

    const url = `/uploads/${req.file.filename}`;

    // altes Foto – falls vorhanden – löschen
    const old = await pool.query("SELECT foto_url FROM stopps WHERE id=$1", [stoppId]);
    const oldUrl = old.rows?.[0]?.foto_url;
    if (oldUrl && oldUrl.startsWith("/uploads/")) {
      const p = path.join(".", oldUrl);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }

    const r = await pool.query(
      "UPDATE stopps SET foto_url=$2 WHERE id=$1 RETURNING *",
      [stoppId, url]
    );

    console.log("📷 Foto gespeichert:", r.rows[0]?.foto_url);
    res.json(r.rows[0]);
  } catch (e) {
    console.error("❌ Fehler beim Foto-Upload:", e);
    res.status(500).json({ error: "Fehler beim Foto-Upload" });
  }
});

// Foto löschen
app.delete("/stopps/:stoppId/foto", auth, async (req, res) => {
  try {
    const stoppId = Number(req.params.stoppId);
    const r1 = await pool.query("SELECT foto_url FROM stopps WHERE id=$1", [stoppId]);
    const url = r1.rows?.[0]?.foto_url;

    if (url && url.startsWith("/uploads/")) {
      const p = path.join(".", url);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }

    const r2 = await pool.query("UPDATE stopps SET foto_url=NULL WHERE id=$1 RETURNING *", [stoppId]);
    console.log("🗑️ Foto entfernt:", stoppId);
    res.json(r2.rows[0]);
  } catch (e) {
    console.error("❌ Fehler beim Foto-Löschen:", e);
    res.status(500).json({ error: "Fehler beim Foto-Löschen" });
  }
});

// ============================================================
// DEBUG: Zeigt alle Touren in der Datenbank
// ============================================================
app.get("/touren-debug", async (_req, res) => {
  try {
    const result = await pool.query("SELECT * FROM touren ORDER BY datum DESC");
    console.log("📋 Aktuelle Touren in DB:", result.rows);
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Fehler /touren-debug:", err);
    res.status(500).json({ error: "Fehler bei touren-debug" });
  }
});

// ============================================================
// Start
// ============================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Tourenplan Backend läuft auf Port ${PORT}`));
