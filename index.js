const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const db = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/");
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// Beispielroute
app.get("/", (req, res) => {
  res.send("🚀 Tourenplan API läuft!");
});

// Fahrer anlegen
app.post("/fahrer", (req, res) => {
  const { name, benutzername, password_hash } = req.body;
  db.run(
    "INSERT INTO fahrer (name, benutzername, password_hash) VALUES (?, ?, ?)",
    [name, benutzername, password_hash],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID });
    }
  );
});

app.listen(PORT, () => {
  console.log(`🚀 Server läuft auf Port ${PORT}`);
});
