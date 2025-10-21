const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
const jwt = require("jsonwebtoken");

const app = express();
app.use(cors());
app.use(express.json());

const SECRET = process.env.JWT_SECRET || "supersecret"; // besser als Env-Var setzen
const APP_PASSWORD = process.env.APP_PASSWORD || "demo123"; // Passwort als Env-Var setzen

// PostgreSQL-Verbindung
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Middleware: prüft JWT-Token
function authMiddleware(req, res, next) {
  const authHeader = req.headers["authorization"];
  if (!authHeader) return res.status(401).json({ error: "Nicht eingeloggt" });

  const token = authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Kein Token" });

  try {
    jwt.verify(token, SECRET);
    next();
  } catch (err) {
    return res.status(403).json({ error: "Ungültiges Token" });
  }
}

// Login-Endpoint
app.post("/login", (req, res) => {
  const { password } = req.body;
  if (password === APP_PASSWORD) {
    const token = jwt.sign({ user: "allowed" }, SECRET, { expiresIn: "12h" });
    return res.json({ token });
  }
  res.status(401).json({ error: "Falsches Passwort" });
});

// --- AB HIER ALLE API-ROUTES MIT authMiddleware schützen ---
// Beispiel:
app.get("/fahrer", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM fahrer ORDER BY id");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Fehler beim Laden der Fahrer" });
  }
});

// ... ALLE DEINE ROUTES (touren, scan, patch, reset, seed-demo usw.)
// einfach überall `authMiddleware` als erstes Argument hinzufügen!
// Beispiel:
// app.get("/touren/:fahrer_id/:datum", authMiddleware, async (req, res) => { ... })
