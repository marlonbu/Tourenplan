const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("./tourenplan.db");

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS fahrer (
    fahrer_id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    benutzername TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS touren (
    tour_id INTEGER PRIMARY KEY AUTOINCREMENT,
    datum DATE NOT NULL,
    fahrer_id INTEGER NOT NULL,
    status TEXT DEFAULT 'geplant',
    FOREIGN KEY (fahrer_id) REFERENCES fahrer(fahrer_id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS stops (
    stop_id INTEGER PRIMARY KEY AUTOINCREMENT,
    tour_id INTEGER NOT NULL,
    ankunft TIME,
    kommission TEXT,
    kundenadresse TEXT NOT NULL,
    longitude REAL,
    latitude REAL,
    bemerkung TEXT,
    status TEXT DEFAULT 'offen',
    FOREIGN KEY (tour_id) REFERENCES touren(tour_id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS stop_fotos (
    foto_id INTEGER PRIMARY KEY AUTOINCREMENT,
    stop_id INTEGER NOT NULL,
    url TEXT NOT NULL,
    beschreibung TEXT,
    erstellt_am TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (stop_id) REFERENCES stops(stop_id)
  )`);
});

module.exports = db;
