import express from "express";
import bodyParser from "body-parser";
import pg from "pg";
import cors from "cors";
import jwt from "jsonwebtoken";
import fs from "fs";
import path from "path";
import multer from "multer";
import { fileURLToPath } from "url";

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(bodyParser.json());
app.use(cors());

// 🔐 Konfiguration
const JWT_SECRET = process.env.JWT_SECRET || "meinGeheimesToken";
const PORT = process.env.PORT || 10000;

// DB-Config (Render/Heroku-Style)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// Upload-Verzeichnis vorbereiten
const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}
// Statische Auslieferung der Uploads
app.use("/uploads", express.static(UPLOAD_DIR));

// Multer (wir speichern erst im Speicher und schreiben dann manuell mit Wunsch-Dateinamen)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
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

// String-Helper für Dateinamen (umlaute → ae/oe/ue, ß → ss, alles kleinschreiben)
function slugifyLower(s) {
  if (!s) return "";
  const map = { ä: "ae", ö: "oe", ü: "ue", Ä: "ae", Ö: "oe", Ü: "ue", ß: "ss" };
  const replaced = s
    .split("")
    .map((ch) => (map[ch] ? map[ch] : ch))
    .join("");
  return replaced
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

function extFromMime(mime) {
  if (mime === "image/jpeg" || mime === "image/jpg") return ".jpg";
  if (mime === "image/png") return ".png";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/heic") return ".heic";
  if (mime === "image/heif") return ".heif";
  return ".jpg"; // Fallback
}

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

    // stopps inkl. telefon, hinweis, status, foto_url
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
        telefon TEXT,
        hinweis TEXT,
        status TEXT,
        foto_url TEXT
      );
    `);

    // Indizes
    await c.query(`CREATE INDEX IF NOT EXISTS idx_touren_fahrer_datum ON touren(fahrer_id, datum);`);
    await c.query(`CREATE INDEX IF NOT EXISTS idx_stopps_tour_ordnung ON stopps(tour_id, reihenfolge);`);

    // Migration: anmerkung → hinweis
    const colCheck = await c.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'stopps' AND column_name IN ('anmerkung','hinweis','telefon','status','foto_url')
    `);
    const cols = colCheck.rows.map(r => r.column_name);
    if (cols.includes("anmerkung") && !cols.includes("hinweis")) {
      await c.query(`ALTER TABLE stopps RENAME COLUMN anmerkung TO hinweis;`);
    }
    const currentCols = (await c.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'stopps'
    `)).rows.map(r => r.column_name);
    if (!currentCols.includes("telefon")) await c.query(`ALTER TABLE stopps ADD COLUMN telefon TEXT;`);
    if (!currentCols.includes("hinweis")) await c.query(`ALTER TABLE stopps ADD COLUMN hinweis TEXT;`);
    if (!currentCols.includes("status")) await c.query(`ALTER TABLE stopps ADD COLUMN status TEXT;`);
    if (!currentCols.includes("foto_url")) await c.query(`ALTER TABLE stopps ADD COLUMN foto_url TEXT;`);
  });
}

// --- Auth ---
app.post("/login", async (req, res) => {
  const { username, password } = req.body || {};
  const validUser = (username === "Gehlenborg" && password === "Orga1023/");
  if (!validUser) return res.status(401).json({ error: "Login fehlgeschlagen" });

  const token = jwt.sign({ u: "Gehlenborg", r: "admin" }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ token });
});

// --- API ---
app.get("/health", (_, res) => res.json({ ok: true }));

app.get("/fahrer", auth, async (_, res) => {
  try {
    const result = await withClient((c) => c.query(`SELECT id, name FROM fahrer ORDER BY name;`));
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: "Fehler bei /fahrer", details: e.message });
  }
});

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
        `SELECT id, tour_id, adresse, lat, lng, reihenfolge, kunde, kommission, telefon, hinweis, status, foto_url
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

app.patch("/stopps/:stoppId", auth, async (req, res) => {
  const { stoppId } = req.params;
  const { status, hinweis, telefon } = req.body || {};

  const fields = [];
  const values = [];
  let idx = 1;

  if (typeof status !== "undefined") { fields.push(`status = $${idx++}`); values.push(status); }
  if (typeof hinweis !== "undefined") { fields.push(`hinweis = $${idx++}`); values.push(hinweis); }
  if (typeof telefon !== "undefined") { fields.push(`telefon = $${idx++}`); values.push(telefon); }

  if (fields.length === 0) return res.status(400).json({ error: "Keine Felder übergeben" });

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

// 🆕 Foto-Upload: POST /upload-photo/:stoppId  (multipart/form-data, Feld "photo")
app.post("/upload-photo/:stoppId", auth, upload.single("photo"), async (req, res) => {
  const { stoppId } = req.params;
  const file = req.file;

  if (!file) return res.status(400).json({ error: "Keine Datei erhalten" });

  try {
    // Stopp + zugehörige Tour (für Datum) laden
    const row = await withClient((c) =>
      c.query(
        `SELECT s.id AS stopp_id, s.kunde, t.datum
         FROM stopps s
         JOIN touren t ON t.id = s.tour_id
         WHERE s.id = $1
         LIMIT 1`,
        [stoppId]
      )
    );

    if (row.rowCount === 0) return res.status(404).json({ error: "Stopp nicht gefunden" });

    const stopp = row.rows[0];
    const kundeSlug = slugifyLower(stopp.kunde || "kunde");
    const d = new Date(stopp.datum);
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    const base = `${kundeSlug}_${dd}_${mm}_${yyyy}`;

    const ext = extFromMime(file.mimetype);
    const filename = `${base}${ext}`;
    const filePath = path.join(UPLOAD_DIR, filename);

    // Falls Datei existiert, überschreiben (bewusst – gleicher Kunde/Tag => ersetzt)
    fs.writeFileSync(filePath, file.buffer);

    const publicUrl = `/uploads/${filename}`;
    await withClient((c) =>
      c.query(`UPDATE stopps SET foto_url = $1 WHERE id = $2`, [publicUrl, stoppId])
    );

    res.json({
      success: true,
      stoppId: stoppId,
      foto_url: publicUrl,
      filename,
    });
  } catch (e) {
    console.error("Upload-Fehler:", e);
    res.status(500).json({ error: "Fehler beim Foto-Upload", details: e.message });
  }
});

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
        `INSERT INTO stopps (tour_id, adresse, lat, lng, reihenfolge, kunde, kommission, telefon, hinweis, status, foto_url)
         VALUES
         ($1,'Mühlenstraße 10, 49699 Lindern',52.8470,7.7692,1,'Kunde A','KOM-1001','0151 1234567','Anlieferung EG','', NULL),
         ($1,'Cloppenburger Str. 1, 49661 Cloppenburg',52.8479,8.0476,2,'Kunde B','KOM-1002','0173 1234567','Hintereingang nutzen','', NULL),
         ($1,'Staulinie 10, 26122 Oldenburg',53.1410,8.2150,3,'Kunde C','KOM-1003','0441 123456','Bitte anrufen bei Ankunft','', NULL)`,
        [finalTourId]
      );

      return { fahrerId: finalFahrerId, fahrzeugId: finalFahrzeugId, tourId: finalTourId };
    });

    res.json({ message: "✅ Demodaten eingefügt", fahrerId, fahrzeugId, tourId });
  } catch (e) {
    res.status(500).json({ error: "Fehler bei /seed-demo", details: e.message });
  }
});

// --- Start ---
ensureSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`🚀 API läuft auf Port ${PORT}`));
  })
  .catch((e) => {
    console.error("DB-Initialisierung fehlgeschlagen:", e);
    process.exit(1);
  });
