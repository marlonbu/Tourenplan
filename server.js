// server.js – Tourenplan Backend (Render-kompatibel) mit Excel-Import (Downfill von Datum/Fahrer)
// ------------------------------------------------------------------------------------------------

import express from "express";
import bodyParser from "body-parser";
import pg from "pg";
import cors from "cors";
import jwt from "jsonwebtoken";
import fs from "fs";
import path from "path";
import multer from "multer";
import { fileURLToPath } from "url";
import XLSX from "xlsx";
import fetch from "node-fetch";

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(bodyParser.json({ limit: "20mb" }));
app.use(cors());

// -----------------------------------------------------
// 🔐 Konfiguration
// -----------------------------------------------------
const JWT_SECRET = process.env.JWT_SECRET || "meinGeheimesToken";
const PORT = process.env.PORT || 10000;

// PostgreSQL (Render)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// -----------------------------------------------------
// 📁 Upload (vorbereitet – aktuell nicht genutzt)
const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use("/uploads", express.static(UPLOAD_DIR));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// -----------------------------------------------------
// 🔒 Auth Middleware
// -----------------------------------------------------
const auth = (req, res, next) => {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Kein Token" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: "Ungültiger Token" });
  }
};

// -----------------------------------------------------
// 🗄️ DB Schema prüfen/erweitern
// -----------------------------------------------------
async function ensureSchema() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS fahrer (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS touren (
        id SERIAL PRIMARY KEY,
        fahrer_id INTEGER REFERENCES fahrer(id),
        datum DATE NOT NULL
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS stopps (
        id SERIAL PRIMARY KEY,
        tour_id INTEGER REFERENCES touren(id),
        kunde TEXT,
        adresse TEXT,
        kommission TEXT,
        hinweis TEXT,
        telefon TEXT,
        status TEXT,
        foto_url TEXT,
        ankunft TEXT,
        position INTEGER
      );
    `);
  } finally {
    client.release();
  }
}

// -----------------------------------------------------
// 🔧 Helpers: Datum & KW (ISO, Mo–So), Excel-Tools
// -----------------------------------------------------
function parseGermanDate(dstr) {
  if (!dstr) return null;
  if (typeof dstr === "number") {
    const epoch = XLSX.SSF.parse_date_code(dstr);
    if (!epoch) return null;
    return new Date(Date.UTC(epoch.y, epoch.m - 1, epoch.d));
  }
  if (typeof dstr === "string" && dstr.includes(".")) {
    const [dd, mm, yyyy] = dstr.split(".");
    if (dd && mm && yyyy) return new Date(Number(yyyy), Number(mm) - 1, Number(dd));
  }
  const d = new Date(dstr);
  return isNaN(d.getTime()) ? null : d;
}

function isoWeekNumber(date) {
  const tmp = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = (tmp.getUTCDay() + 6) % 7; // Mo=0
  tmp.setUTCDate(tmp.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 4));
  const firstThursdayDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNum + 3);
  const week = 1 + Math.round((tmp - firstThursday) / (7 * 24 * 3600 * 1000));
  return week;
}

function mondayOfISOWeek(week, year) {
  const simple = new Date(year, 0, 1 + (week - 1) * 7);
  const dow = (simple.getDay() + 6) % 7;
  const monday = new Date(simple);
  monday.setDate(simple.getDate() - dow);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function normalizeKey(k) {
  if (!k) return "";
  const key = String(k).trim().toLowerCase();
  if (key === "kw") return "kw";
  if (key === "datum") return "datum";
  if (key === "wochentag") return "wochentag";
  if (key === "fahrer") return "fahrer";
  if (key === "ankunft") return "ankunft";
  if (key === "pos." || key === "pos" || key === "position") return "position";
  if (key === "kommission") return "kommission";
  if (key === "adresse") return "adresse";
  if (key === "telefon" || key === "tel") return "telefon";
  if (key === "hinweis" || key === "anmerkung" || key === "notiz") return "hinweis";
  if (key === "kunde") return "kunde"; // optional
  return key;
}

function mapRowKeys(obj) {
  const mapped = {};
  for (const k of Object.keys(obj)) mapped[normalizeKey(k)] = obj[k];
  return mapped;
}

// Header ab Zeile 8
function adjustRefToRow8(sheet) {
  const ref = sheet["!ref"];
  if (!ref) return sheet["!ref"];
  const [start, end] = ref.split(":");
  const startCol = start.replace(/[0-9]/g, "") || "A";
  return `${startCol}8:${end}`;
}

// -----------------------------------------------------
// 🔑 Login
// -----------------------------------------------------
app.post("/login", async (req, res) => {
  const { username, password } = req.body || {};
  const validUser = username === "Gehlenborg" && password === "Orga1023/";
  if (!validUser) return res.status(401).json({ error: "Login fehlgeschlagen" });

  const token = jwt.sign({ user: username }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ token });
});

// -----------------------------------------------------
// 👤 Fahrer
// -----------------------------------------------------
app.get("/fahrer", auth, async (_, res) => {
  const { rows } = await pool.query("SELECT id, name FROM fahrer ORDER BY name;");
  res.json(rows);
});

// -----------------------------------------------------
// 🚚 Touren pro Fahrer/Datum
// -----------------------------------------------------
app.get("/touren/:fahrerId/:datum", auth, async (req, res) => {
  const { fahrerId, datum } = req.params;
  const tour = await pool.query(
    "SELECT id, fahrer_id, datum FROM touren WHERE fahrer_id=$1 AND datum=$2 LIMIT 1",
    [fahrerId, datum]
  );
  if (tour.rowCount === 0) return res.json({ tour: null, stopps: [] });
  const tourId = tour.rows[0].id;

  const stopps = await pool.query(
    "SELECT * FROM stopps WHERE tour_id=$1 ORDER BY COALESCE(position, id) ASC",
    [tourId]
  );
  res.json({ tour: tour.rows[0], stopps: stopps.rows });
});

// -----------------------------------------------------
// 🆕 Wochen-Endpunkt (alle Fahrer, Mo–So, chronologisch)
app.get("/touren-woche/:kw", auth, async (req, res) => {
  const kw = parseInt(req.params.kw);
  if (isNaN(kw) || kw < 1 || kw > 53) {
    return res.status(400).json({ error: "Ungültige Kalenderwoche" });
  }
  const year = new Date().getFullYear();
  const monday = mondayOfISOWeek(kw, year);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const startDate = monday.toISOString().split("T")[0];
  const endDate = sunday.toISOString().split("T")[0];

  try {
    const query = `
      SELECT
        f.name AS fahrer,
        s.kunde,
        s.kommission,
        s.hinweis,
        t.datum
      FROM stopps s
      JOIN touren t ON s.tour_id = t.id
      JOIN fahrer f ON t.fahrer_id = f.id
      WHERE t.datum BETWEEN $1 AND $2
      ORDER BY t.datum ASC, f.name ASC, COALESCE(s.position, s.id) ASC;
    `;
    const { rows } = await pool.query(query, [startDate, endDate]);
    res.json({ kw, startDate, endDate, touren: rows });
  } catch (err) {
    console.error("Fehler bei /touren-woche:", err);
    res.status(500).json({ error: "Fehler beim Laden der Wochentouren" });
  }
});

// -----------------------------------------------------
// 🌱 Demo-Daten (Beispiel)
app.get("/seed-demo", auth, async (_, res) => {
  await pool.query("TRUNCATE stopps, touren, fahrer RESTART IDENTITY;");
  const fahrer = await pool.query("INSERT INTO fahrer (name) VALUES ('Christoph Arlt') RETURNING id;");
  const fahrerId = fahrer.rows[0].id;

  const today = new Date();
  const tour = await pool.query(
    "INSERT INTO touren (fahrer_id, datum) VALUES ($1, $2) RETURNING id;",
    [fahrerId, today.toISOString().split("T")[0]]
  );
  const tourId = tour.rows[0].id;

  const stopps = [
    ["Kunde A", "Möhlenkamp 26, 49681 Garrel", "12345", "Anlieferung am Vormittag", "08:30", 1, "04999 12345"],
    ["Kunde B", "Schwaneburger Weg 39, 26169 Friesoythe", "23456", "Bitte vorher anrufen", "10:00", 2, "04491 5555"],
    ["Kunde C", "Am Rundtörn 18, 26135 Oldenburg", "34567", "Hintereingang nutzen", "12:00", 3, ""],
    ["Kunde D", "Wiesenstr. 31a, 28857 Syke", "45678", "Ladung nur absetzen", "14:00", 4, ""],
  ];

  for (const [kunde, adresse, kommission, hinweis, ankunft, position, telefon] of stopps) {
    await pool.query(
      `INSERT INTO stopps (tour_id, kunde, adresse, kommission, hinweis, ankunft, position, telefon)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8);`,
      [tourId, kunde, adresse, kommission, hinweis, ankunft, position, telefon]
    );
  }
  res.json({ message: "Demo-Daten erfolgreich erstellt" });
});

// -----------------------------------------------------
// 🧹 Reset
app.get("/reset", auth, async (_, res) => {
  await pool.query("TRUNCATE stopps, touren, fahrer RESTART IDENTITY;");
  res.json({ message: "Tabellen geleert" });
});

// -----------------------------------------------------
// 📥 Excel-Import (Downfill von Datum & Fahrer, Multi-Stop pro Tag)
// Body:
//   { "source": "local", "path": "/mnt/data/Tourenplan.xlsx" }
//   { "source": "url",   "url":  "https://..." }
// Optional: { "sheet": "Tabelle1" }
app.post("/import-excel", auth, async (req, res) => {
  const { source, path: localPath, url, sheet } = req.body || {};
  try {
    let workbook;
    if (source === "local" && localPath) {
      const abs = localPath.startsWith("/") ? localPath : path.resolve(__dirname, localPath);
      if (!fs.existsSync(abs)) return res.status(400).json({ error: "Datei nicht gefunden", path: abs });
      const buf = fs.readFileSync(abs);
      workbook = XLSX.read(buf, { type: "buffer" });
    } else if (source === "url" && url) {
      const r = await fetch(url);
      if (!r.ok) return res.status(400).json({ error: "Download fehlgeschlagen", status: r.status });
      const ab = await r.arrayBuffer();
      workbook = XLSX.read(Buffer.from(ab), { type: "buffer" });
    } else {
      return res.status(400).json({ error: "Bitte source + path (local) oder source + url angeben" });
    }

    const sheetName = sheet || workbook.SheetNames[0];
    const ws = workbook.Sheets[sheetName];
    if (!ws) return res.status(400).json({ error: "Worksheet nicht gefunden", sheet: sheetName });

    // Bereich ab Zeile 8 (Header in Zeile 8)
    const originalRef = ws["!ref"];
    ws["!ref"] = adjustRefToRow8(ws);
    let rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
    ws["!ref"] = originalRef;

    // Keys normalisieren
    rows = rows.map(mapRowKeys);

    // Downfill von Datum & Fahrer innerhalb der Liste
    let lastDate = null;
    let lastFahrer = "";
    rows = rows.map((r) => {
      // Datum ggf. übernehmen
      const dParsed = parseGermanDate(r.datum);
      if (dParsed) {
        lastDate = dParsed;
      }
      // Fahrer ggf. übernehmen
      if ((r.fahrer || "").toString().trim() !== "") {
        lastFahrer = (r.fahrer || "").toString().trim();
      }
      return {
        ...r,
        _parsedDate: lastDate ? new Date(lastDate) : null,
        _driverFilled: lastFahrer,
      };
    });

    // Nur Zeilen importieren, die inhaltlich relevant sind
    rows = rows.filter((r) => {
      const hasAny =
        (r.adresse && String(r.adresse).trim() !== "") ||
        (r.kommission && String(r.kommission).trim() !== "") ||
        (r._driverFilled && String(r._driverFilled).trim() !== "");
      return hasAny && !!r._parsedDate;
    });

    const client = await pool.connect();
    try {
      // Caches
      const fahrerIds = new Map(); // name -> id
      const tourIds = new Map();   // `${fahrerId}|${datumIso}` -> id
      const nextPos = new Map();   // tourId -> next position (auto)

      async function getFahrerId(name) {
        const key = (name || "").trim() || "Unbekannter Fahrer";
        if (fahrerIds.has(key)) return fahrerIds.get(key);
        let q = await client.query("SELECT id FROM fahrer WHERE name=$1 LIMIT 1;", [key]);
        if (q.rowCount === 0) {
          q = await client.query("INSERT INTO fahrer (name) VALUES ($1) RETURNING id;", [key]);
        }
        const id = q.rows[0].id;
        fahrerIds.set(key, id);
        return id;
      }

      async function getTourId(fahrerId, datumIso) {
        const key = `${fahrerId}|${datumIso}`;
        if (tourIds.has(key)) return tourIds.get(key);
        let q = await client.query("SELECT id FROM touren WHERE fahrer_id=$1 AND datum=$2 LIMIT 1;", [fahrerId, datumIso]);
        if (q.rowCount === 0) {
          q = await client.query("INSERT INTO touren (fahrer_id, datum) VALUES ($1, $2) RETURNING id;", [fahrerId, datumIso]);
        }
        const id = q.rows[0].id;
        tourIds.set(key, id);
        return id;
      }

      let createdStopps = 0;
      let skipped = 0;

      for (const r of rows) {
        const d = r._parsedDate;
        if (!d) { skipped++; continue; }
        const datumIso = d.toISOString().split("T")[0];

        const fahrerName = r._driverFilled || (r.fahrer || "").toString().trim() || "Unbekannter Fahrer";
        const fahrerId = await getFahrerId(fahrerName);
        const tourId = await getTourId(fahrerId, datumIso);

        // Positionsfindung
        let position = null;
        if (r.position !== undefined && r.position !== "") {
          const p = parseInt(r.position, 10);
          if (!isNaN(p)) position = p;
        }
        if (position == null) {
          const current = nextPos.get(tourId) || 1;
          position = current;
          nextPos.set(tourId, current + 1);
        }

        // Inhalte
        const adresse = (r.adresse || "").toString().trim();
        const kommission = (r.kommission || "").toString().trim();
        const telefon = (r.telefon || "").toString().trim();
        const hinweis = (r.hinweis || "").toString().trim();
        const kunde = (r.kunde || "").toString().trim() || null;
        const ankunft = (r.ankunft || "").toString().trim() || null;

        // Wenn wirklich gar kein Stopp-Inhalt da ist → überspringen
        if (!adresse && !kommission) { skipped++; continue; }

        await client.query(
          `INSERT INTO stopps (tour_id, kunde, adresse, kommission, hinweis, telefon, ankunft, position)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8);`,
          [tourId, kunde, adresse, kommission, hinweis, telefon, ankunft, position]
        );

        createdStopps++;
      }

      res.json({
        message: "Excel-Import abgeschlossen",
        rowsProcessed: rows.length,
        stoppsCreated: createdStopps,
        skipped,
      });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("Fehler beim Excel-Import:", err);
    res.status(500).json({ error: "Fehler beim Excel-Import", detail: String(err) });
  }
});

// -----------------------------------------------------
// 🚀 Start
ensureSchema().then(() => {
  app.listen(PORT, () => console.log(`🚀 API läuft auf Port ${PORT}`));
});
