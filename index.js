const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
const db = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());

// Hilfsfunktion: Adresse → Koordinaten
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

// Touren abrufen
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
  const { datum, fahrer_id, kundenadresse, status } = req.body;

  try {
    const coords = await geocodeAdresse(kundenadresse);

    const stmt = db.prepare(`
      INSERT INTO touren (datum, fahrer_id, kundenadresse, status, latitude, longitude)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      datum,
      fahrer_id,
      kundenadresse,
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
    res.status(500).json({ error: "Fehler beim Geocoding" });
  }
});

// Server starten
app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
