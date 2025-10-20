// SEED-ENDPUNKT für Demodaten
app.get("/seed", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Fahrer einfügen
    const fahrerResult = await client.query(
      "INSERT INTO fahrer (name) VALUES ($1) RETURNING id",
      ["Hans Mustermann"]
    );
    const fahrerId = fahrerResult.rows[0].id;

    // Fahrzeug einfügen
    const fahrzeugResult = await client.query(
      "INSERT INTO fahrzeuge (typ, kennzeichen) VALUES ($1, $2) RETURNING id",
      ["Sprinter", "CLP-HG 123"]
    );
    const fahrzeugId = fahrzeugResult.rows[0].id;

    // Tour einfügen (Datum = heute)
    const heute = new Date().toISOString().slice(0, 10);
    const tourResult = await client.query(
      "INSERT INTO touren (datum, fahrzeug_id, fahrer_id, startzeit, bemerkung) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [heute, fahrzeugId, fahrerId, "08:00", "Demo-Tour"]
    );
    const tourId = tourResult.rows[0].id;

    // Stopp einfügen
    await client.query(
      "INSERT INTO stopps (tour_id, adresse, lat, lng, reihenfolge, qr_code) VALUES ($1, $2, $3, $4, $5, $6)",
      [tourId, "Musterstraße 1, 12345 Musterstadt", 52.52, 13.405, 1, "QR-DEMO-123"]
    );

    await client.query("COMMIT");

    res.json({
      message: "✅ Demodaten eingefügt",
      fahrerId,
      fahrzeugId,
      tourId
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Fehler beim Seed:", err);
    res.status(500).json({ error: "Fehler beim Einfügen der Demodaten", details: err.message });
  } finally {
    client.release();
  }
});
