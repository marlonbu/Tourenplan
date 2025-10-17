const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database(":memory:");

// Tabellen erstellen
db.serialize(() => {
  // Fahrer
  db.run(`
    CREATE TABLE IF NOT EXISTS fahrer (
      fahrer_id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT
    )
  `);

  // Touren
  db.run(`
    CREATE TABLE IF NOT EXISTS touren (
      tour_id INTEGER PRIMARY KEY AUTOINCREMENT,
      datum TEXT,
      wochentag TEXT,
      fahrer_id INTEGER,
      ankunft TEXT,
      kommission TEXT,
      kundenadresse TEXT,
      bemerkung TEXT,
      status TEXT,
      latitude REAL,
      longitude REAL,
      FOREIGN KEY(fahrer_id) REFERENCES fahrer(fahrer_id)
    )
  `);

  // Tour-Stopps (falls mehrere Adressen pro Tour)
  db.run(`
    CREATE TABLE IF NOT EXISTS tourstopps (
      stopp_id INTEGER PRIMARY KEY AUTOINCREMENT,
      tour_id INTEGER,
      kundenadresse TEXT,
      bemerkung TEXT,
      latitude REAL,
      longitude REAL,
      FOREIGN KEY(tour_id) REFERENCES touren(tour_id)
    )
  `);
});

module.exports = db;
