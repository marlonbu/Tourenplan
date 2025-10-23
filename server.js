// server.js – Tourenplan Backend (Render-kompatibel)
// ---------------------------------------------------------------
// Features:
// - JWT Login
// - Fahrer-/Tour-/Stopp-APIs
// - Wochen-Endpunkt /touren-woche/:kw (Mo–So, chronologisch)
// - Excel-Import: manuell (POST /import-excel) & automatisch alle 30 Min.
// - Excel-Layout: Header ab Zeile 8, Downfill von Datum & Fahrer, mehrere Stopps pro Tag
// - Pro Fahrer+Datum: vorhandene Tour/Stopps werden vor Neuimport gelöscht (keine Duplikate)
// ---------------------------------------------------------------

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

// OneDrive Excel: Download-Link & Intervall (ms)
const EXCEL_URL =
  process.env.EXCEL_URL ||
  "https://gehlenborgsitzmoebel-my.sharepoint.com/:x:/g/personal/marlon_moebel-gehlenborg_de/EfXEyJHsUKdEj-VGjbSKCBsBAEl-6Fx5_k9LtOTyljv5ig?download=1";

const IMPORT_INTERVAL_MS = Number(process.env.IMPORT_INTERVAL_MS || 30 * 60 * 1000); // 30 Min

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
        tour_id INTEGER REFERENCES touren(id) ON DELETE CASCADE,
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
    // Indexe für schnellere wöchentliche Abfragen & Ersetzungen
    await client.query(`CREATE INDEX IF NOT EXISTS idx_touren_fahrer_datum ON touren(fahrer_id, datum);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_stopps_tour_id ON stopps(tour_id);`);
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
    // Achtung: epoch ist UTC; wir erzeugen lokales Date-Objekt
    return new Date(epoch.y, epoch.m - 1, epoch.d);
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

// Header ab Zeile 8
function adjustRefToRow8(sheet) {
  const ref = sheet["!ref"];
  if (!ref) return sheet["!ref"];
  const [start, end] = ref.split(":");
  const startCol = start.replace(/[0-9]/g, "") || "A";
  return `${startCol}8:${end}`;
}

// Key-Normalisierung (DE-Header)
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
// -----------------------------------------------------
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
// -----------------------------------------------------
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
// -----------------------------------------------------
app.get("/reset", auth, async (_, res) => {
  await pool.query("TRUNCATE stopps, touren, fahrer RESTART IDENTITY;");
  res.json({ message: "Tabellen geleert" });
});

// -----------------------------------------------------
// 📥 MANUELLER Excel-Import (optional nutzbar)
// Body:
//   { "source": "local", "path": "/mnt/data/Tourenplan.xlsx" }
//   { "source": "url",   "url":  "https://..." }
// Optional: { "sheet": "Tabelle1" }
// -----------------------------------------------------
app.post("/import-excel", auth, async (req, res) => {
  try {
    const result = await importExcel({ mode: "manual", body: req.body || {} });
    res.json(result);
  } catch (err) {
    console.error("Fehler beim manuellen Excel-Import:", err);
    res.status(500).json({ error: "Fehler beim Excel-Import", detail: String(err) });
  }
});

// -----------------------------------------------------
// 🧠 Kern: Excel laden, parsen & in DB schreiben (mit Lösch/Neu je Fahrer+Datum)
// -----------------------------------------------------
async function importExcel({ mode = "auto", body = {} } = {}) {
  // 1) Datei laden (URL oder lokal)
  let workbook;
  if (mode === "manual") {
    const { source, path: localPath, url, sheet } = body;
    if (source === "local" && localPath) {
      const abs = localPath.startsWith("/") ? localPath : path.resolve(__dirname, localPath);
      if (!fs.existsSync(abs)) throw new Error(`Datei nicht gefunden: ${abs}`);
      const buf = fs.readFileSync(abs);
      workbook = XLSX.read(buf, { type: "buffer" });
    } else if (source === "url" && url) {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Download fehlgeschlagen: HTTP ${r.status}`);
      const ab = await r.arrayBuffer();
      workbook = XLSX.read(Buffer.from(ab), { type: "buffer" });
    } else {
      // fallback: System-URL (OneDrive)
      const r = await fetch(EXCEL_URL);
      if (!r.ok) throw new Error(`Download fehlgeschlagen: HTTP ${r.status}`);
      const ab = await r.arrayBuffer();
      workbook = XLSX.read(Buffer.from(ab), { type: "buffer" });
    }
  } else {
    // auto: immer System-URL nutzen
    const r = await fetch(EXCEL_URL);
    if (!r.ok) throw new Error(`Download fehlgeschlagen: HTTP ${r.status}`);
    const ab = await r.arrayBuffer();
    workbook = XLSX.read(Buffer.from(ab), { type: "buffer" });
  }

  // 2) Sheet & Header ab Zeile 8
  const sheetName = workbook.SheetNames[0];
  const ws = workbook.Sheets[sheetName];
  if (!ws) throw new Error(`Worksheet nicht gefunden: ${sheetName}`);

  const originalRef = ws["!ref"];
  ws["!ref"] = adjustRefToRow8(ws);
  let rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
  ws["!ref"] = originalRef;

  // 3) Keys normalisieren & Downfill von Datum/Fahrer
  rows = rows.map(mapRowKeys);

  let lastDate = null;
  let lastFahrer = "";
  rows = rows.map((r) => {
    const dParsed = parseGermanDate(r.datum);
    if (dParsed) lastDate = dParsed;
    if ((r.fahrer || "").toString().trim() !== "") lastFahrer = (r.fahrer || "").toString().trim();
    return {
      ...r,
      _parsedDate: lastDate ? new Date(lastDate) : null,
      _driverFilled: lastFahrer,
    };
  });

  // 4) Relevante Zeilen: nur solche mit Inhalt (Adresse/Kommission/Fahrer) UND gültigem Datum
  rows = rows.filter((r) => {
    const hasAny =
      (r.adresse && String(r.adresse).trim() !== "") ||
      (r.kommission && String(r.kommission).trim() !== "") ||
      (r._driverFilled && String(r._driverFilled).trim() !== "");
    return hasAny && !!r._parsedDate;
  });

  const client = await pool.connect();
  try {
    const fahrerIds = new Map(); // name -> id
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

    // Wir sammeln alle (fahrerId, datumIso) Paare, die im Import vorkommen.
    // Für jedes Paar löschen wir VOR dem Einfügen vorhandene Touren/Stopps.
    const pairsToReplace = new Map(); // key -> { fahrerId, datumIso }
    const preparedRows = [];

    for (const r of rows) {
      const d = r._parsedDate;
      if (!d) continue;
      const datumIso = d.toISOString().split("T")[0];
      const fahrerName = r._driverFilled || (r.fahrer || "").toString().trim() || "Unbekannter Fahrer";
      const fahrerId = await getFahrerId(fahrerName);

      const key = `${fahrerId}|${datumIso}`;
      if (!pairsToReplace.has(key)) pairsToReplace.set(key, { fahrerId, datumIso });

      // Inhalte vorbereiten
      const adresse = (r.adresse || "").toString().trim();
      const kommission = (r.kommission || "").toString().trim();
      const telefon = (r.telefon || "").toString().trim();
      const hinweis = (r.hinweis || "").toString().trim();
      const kunde = (r.kunde || "").toString().trim() || null;
      const ankunft = (r.ankunft || "").toString().trim() || null;

      let position = null;
      if (r.position !== undefined && r.position !== "") {
        const p = parseInt(r.position, 10);
        if (!isNaN(p)) position = p;
      }

      // Nur echte Stopps (Adresse oder Kommission) vormerken
      if (adresse || kommission) {
        preparedRows.push({
          fahrerId,
          datumIso,
          kunde,
          adresse,
          kommission,
          hinweis,
          telefon,
          ankunft,
          position,
        });
      }
    }

    // Für jedes betroffene (fahrerId, datumIso) Paar: vorhandene Touren + Stopps löschen
    for (const { fahrerId, datumIso } of pairsToReplace.values()) {
      const tours = await client.query(
        "SELECT id FROM touren WHERE fahrer_id=$1 AND datum=$2;",
        [fahrerId, datumIso]
      );
      if (tours.rowCount > 0) {
        const tourIds = tours.rows.map((r) => r.id);
        // Stopps löschen (ON DELETE CASCADE ist gesetzt, aber sicherheitshalber explizit):
        await client.query("DELETE FROM stopps WHERE tour_id = ANY($1::int[]);", [tourIds]);
        await client.query("DELETE FROM touren WHERE id = ANY($1::int[]);", [tourIds]);
      }
      // Neue Tour anlegen
      await client.query("INSERT INTO touren (fahrer_id, datum) VALUES ($1,$2);", [fahrerId, datumIso]);
    }

    // Nach Löschen neue Tour-IDs aufbauen
    const tourIdCache = new Map(); // `${fahrerId}|${datumIso}` -> id
    async function ensureTourId(fahrerId, datumIso) {
      const key = `${fahrerId}|${datumIso}`;
      if (tourIdCache.has(key)) return tourIdCache.get(key);
      const q = await client.query(
        "SELECT id FROM touren WHERE fahrer_id=$1 AND datum=$2 LIMIT 1;",
        [fahrerId, datumIso]
      );
      const id = q.rows[0].id;
      tourIdCache.set(key, id);
      return id;
    }

    // Positions-Autoinkrement pro Tour (falls Position fehlt)
    const nextPos = new Map(); // tourId -> next position

    let createdStopps = 0;
    for (const p of preparedRows) {
      const tourId = await ensureTourId(p.fahrerId, p.datumIso);

      let pos = p.position;
      if (pos == null) {
        const current = nextPos.get(tourId) || 1;
        pos = current;
        nextPos.set(tourId, current + 1);
      }

      await client.query(
        `INSERT INTO stopps (tour_id, kunde, adresse, kommission, hinweis, telefon, ankunft, position)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8);`,
        [tourId, p.kunde, p.adresse, p.kommission, p.hinweis, p.telefon, p.ankunft, pos]
      );
      createdStopps++;
    }

    return {
      message: "Excel-Import abgeschlossen",
      pairsReplaced: pairsToReplace.size,
      stoppsCreated: createdStopps,
      rowsConsidered: rows.length,
    };
  } finally {
    client.release();
  }
}

// -----------------------------------------------------
// ⏱️ Automatischer Import alle 30 Minuten
// -----------------------------------------------------
async function runAutoImportOnce() {
  try {
    const result = await importExcel({ mode: "auto" });
    console.log("✅ Auto-Import OK:", result);
  } catch (err) {
    console.error("⚠️ Auto-Import Fehler:", err?.message || err);
  }
}

// Beim Serverstart einmal versuchen:
ensureSchema().then(async () => {
  app.listen(PORT, () => console.log(`🚀 API läuft auf Port ${PORT}`));
  // Erstimport beim Start:
  runAutoImportOnce();
  // Danach im Intervall:
  setInterval(runAutoImportOnce, IMPORT_INTERVAL_MS);
});
