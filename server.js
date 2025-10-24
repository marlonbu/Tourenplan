// server.js – Lokaler Excel-Import mit Datumskonvertierung
//---------------------------------------------------------------
import express from "express";
import bodyParser from "body-parser";
import pg from "pg";
import cors from "cors";
import jwt from "jsonwebtoken";
import path from "path";
import fs from "fs";
import XLSX from "xlsx";
import { fileURLToPath } from "url";

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(bodyParser.json());
app.use(cors());

const JWT_SECRET = process.env.JWT_SECRET || "meinGeheimesToken";
const PORT = process.env.PORT || 10000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// -----------------------------------------------------
// 🔐 Auth Middleware
// -----------------------------------------------------
const auth = (req, res, next) => {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: "Kein Token" });
  const token = header.split(" ")[1];
  try {
    const user = jwt.verify(token, JWT_SECRET);
    req.user = user;
    next();
  } catch (err) {
    res.status(401).json({ error: "Ungültiger Token" });
  }
};

// -----------------------------------------------------
// 🗄️ DB Schema prüfen
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
    console.log("✅ Tabellen überprüft/erstellt");
  } finally {
    client.release();
  }
}

// -----------------------------------------------------
// 📅 Hilfsfunktion: Excel-Datum umwandeln
// -----------------------------------------------------
function excelDateToISO(value) {
  if (!value) return null;

  // Falls schon Textdatum
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!isNaN(parsed)) return parsed.toISOString().split("T")[0];
  }

  // Falls Zahl (Excel-Zeitstempel)
  if (typeof value === "number") {
    const base = new Date(Date.UTC(1899, 11, 30)); // Excel base date
    const date = new Date(base.getTime() + value * 86400000);
    return date.toISOString().split("T")[0];
  }

  return null;
}

// -----------------------------------------------------
// 🧠 Excel-Import (lokal)
// -----------------------------------------------------
async function importExcel() {
  try {
    const filePath = path.join(__dirname, "data", "Tourenplan.xlsx");
    if (!fs.existsSync(filePath)) throw new Error("Excel-Datei nicht gefunden!");

    const workbook = XLSX.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const range = sheet["!ref"].split(":")[1];
    sheet["!ref"] = `A8:${range}`; // ab Zeile 8
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

    const client = await pool.connect();
    await client.query("BEGIN");
    await client.query("TRUNCATE stopps, touren, fahrer RESTART IDENTITY;");

    const fahrerMap = new Map();

    for (const row of rows) {
      if (!row.Fahrer || !row.Datum || !row.Adresse) continue;

      // Fahrer-ID
      const name = row.Fahrer.trim();
      let fahrerId = fahrerMap.get(name);
      if (!fahrerId) {
        const res = await client.query(
          "INSERT INTO fahrer (name) VALUES ($1) RETURNING id;",
          [name]
        );
        fahrerId = res.rows[0].id;
        fahrerMap.set(name, fahrerId);
      }

      // Datum umwandeln
      const datumISO = excelDateToISO(row.Datum);
      if (!datumISO) continue;

      const tourRes = await client.query(
        "INSERT INTO touren (fahrer_id, datum) VALUES ($1, $2) RETURNING id;",
        [fahrerId, datumISO]
      );
      const tourId = tourRes.rows[0].id;

      await client.query(
        `INSERT INTO stopps 
         (tour_id, kunde, adresse, kommission, hinweis, telefon, status, ankunft, position)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9);`,
        [
          tourId,
          row.Kunde || "",
          row.Adresse || "",
          row.Kommission || "",
          row.Hinweis || "",
          row.Telefon || "",
          row.Status || "",
          row.Ankunft || "",
          row.Pos || null,
        ]
      );
    }

    await client.query("COMMIT");
    client.release();
    console.log(`📊 Excel importiert: ${rows.length} Zeilen`);
  } catch (err) {
    console.error("⚠️ Excel-Import Fehler:", err.message);
  }
}

// -----------------------------------------------------
// 🔑 Login
// -----------------------------------------------------
app.post("/login", (req, res) => {
  const { username, password } = req.body;
  if (username === "Gehlenborg" && password === "Orga1023/") {
    const token = jwt.sign({ user: username }, JWT_SECRET, { expiresIn: "7d" });
    return res.json({ token });
  }
  res.status(401).json({ error: "Login fehlgeschlagen" });
});

// -----------------------------------------------------
// 👤 Fahrer
// -----------------------------------------------------
app.get("/fahrer", auth, async (_, res) => {
  const { rows } = await pool.query("SELECT id, name FROM fahrer ORDER BY name;");
  res.json(rows);
});

// -----------------------------------------------------
// 🚚 Touren
// -----------------------------------------------------
app.get("/touren/:fahrerId/:datum", auth, async (req, res) => {
  const { fahrerId, datum } = req.params;
  const tour = await pool.query(
    "SELECT id FROM touren WHERE fahrer_id=$1 AND datum=$2 LIMIT 1;",
    [fahrerId, datum]
  );
  if (tour.rowCount === 0) return res.json({ tour: null, stopps: [] });
  const stopps = await pool.query(
    "SELECT * FROM stopps WHERE tour_id=$1 ORDER BY COALESCE(position,id) ASC;",
    [tour.rows[0].id]
  );
  res.json({ tour: tour.rows[0], stopps: stopps.rows });
});

// -----------------------------------------------------
// 🧹 Reset
// -----------------------------------------------------
app.get("/reset", auth, async (_, res) => {
  await pool.query("TRUNCATE stopps, touren, fahrer RESTART IDENTITY;");
  res.json({ message: "Tabellen geleert" });
});

// -----------------------------------------------------
// 🗓️ Root
// -----------------------------------------------------
app.get("/", (_, res) => {
  res.send("✅ Tourenplan Backend läuft mit lokalem Excel-Import");
});

// -----------------------------------------------------
// 🚀 Start
// -----------------------------------------------------
ensureSchema().then(() => {
  app.listen(PORT, () => console.log(`🚀 API läuft auf Port ${PORT}`));
  importExcel(); // einmalig beim Start laden
});
