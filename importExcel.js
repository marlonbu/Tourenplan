const xlsx = require("xlsx");
const fetch = require("node-fetch");

// Excel laden
const workbook = xlsx.readFile("Touren Test.xlsx");
const sheet = workbook.Sheets[workbook.SheetNames[0]];
const data = xlsx.utils.sheet_to_json(sheet);

// Backend-URL anpassen
const API_URL = "https://tourenplan.onrender.com";

// Cache für Fahrer (Name → ID)
const fahrerCache = {};

async function importiereDaten() {
  for (const row of data) {
    const { Datum, Wochentag, Fahrer, Ankunft, Kommission, Kundenadresse, Bemerkung, Status } = row;

    // Fahrer anlegen, falls noch nicht existiert
    if (!fahrerCache[Fahrer]) {
      const res = await fetch(`${API_URL}/fahrer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: Fahrer })
      });
      const fahrer = await res.json();
      fahrerCache[Fahrer] = fahrer.id;
    }

    // Tour anlegen
    await fetch(`${API_URL}/touren`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        datum: Datum,
        wochentag: Wochentag,
        fahrer_id: fahrerCache[Fahrer],
        ankunft: Ankunft,
        kommission: Kommission,
        kundenadresse: Kundenadresse,
        bemerkung: Bemerkung || "",
        status: Status || "geplant"
      })
    });

    console.log(`✅ Tour für ${Fahrer} → ${Kundenadresse} importiert`);
  }
}

importiereDaten();
