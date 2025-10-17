const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
const db = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());

// Hilfsfunktion: Adresse → Koordinaten (Nominatim API)
async function geocodeAdresse(adresse) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(adresse)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'tourenplan-app' } });
  const data = await res.json();

  if (data && data.length > 0) {
    return {
      lat: parseFloat(data[0].lat),
      lon: parseFloat(data[0].lon)
    };
  } else {
    return null;
  }
}

// ------------------- ROUTES -------------------

// Alle Touren abrufen
app.get("/touren", (req, res) => {
  db.all("SELECT * FROM touren", (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// Neue Tour speichern (mit Geocoding)
app.post("/touren", async (req, res) => {
  const { datum, wochentag, fahrer_id, ankunft, kommission, kundenadresse, bemerkung, status } = req.body;

  try {
    const coords = await geocodeAdresse(kundenadresse);

    const stmt = db.prepare(`
      INSERT INTO touren (datum, wochentag, fahrer_id, ankunft, kommission, kundenadresse, bemerkung, status, latitude, longitude)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      datum,
      wochentag,
      fahrer_id,
      ankunft,
      kommission,
      kundenadresse,
      bemerkung,
      status,
      coords?.lat || null,
      coords?.lon || null,
      function (err) {
        if (err) {
          return res.status(500).json({ error: err.message });
        }
        res.json({ id: this.lastID, message: "Tour gespeichert" });
      }
    );
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Fehler beim Geocoding" });
  }
});

// Fahrer abrufen
app.get("/fahrer", (req, res) => {
  db.all("SELECT * FROM fahrer", (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// Neuen Fahrer anlegen
app.post("/fahrer", (req, res) => {
  const { name } = req.body;
  const stmt = db.prepare("INSERT INTO fahrer (name) VALUES (?)");
  stmt.run(name, function (err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({ id: this.lastID, message: "Fahrer gespeichert" });
  });
});

// Server starten
app.listen(PORT, () => {
  console.log(`✅ Server läuft auf Port ${PORT}`);
});
