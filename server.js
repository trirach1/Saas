import express from "express";
import makeWASocket, { useMultiFileAuthState } from "@whiskeysockets/baileys";
import QRCode from "qrcode";

const app = express();
app.use(express.json());

// GLOBAL SESSIONS STORE
const sessions = {};

// HEALTH CHECK ENDPOINT
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

// INIT SESSION
app.post("/init", async (req, res) => {
  try {
    const { profile, pairing } = req.body;

    if (!profile) {
      return res.status(400).json({ success: false, error: "profile is required" });
    }

    const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${profile}`);

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false
    });

    sock.ev.on("creds.update", saveCreds);

    sessions[profile] = sock;

    return res.json({
      success: true,
      message: "Client initializing",
      profile
    });
  } catch (e) {
    console.error("INIT ERROR:", e);
    res.status(500).json({ error: e.message });
  }
});

// RETURN QR CODE
app.get("/qr", async (req, res) => {
  try {
    const profile = req.query.profile;

    if (!profile) return res.status(400).send("profile is required");
    if (!sessions[profile]) return res.status(404).send("session not found");

    let qrData;
    sessions[profile].ev.on("connection.update", async (update) => {
      if (update.qr) {
        qrData = update.qr;
        const svg = await QRCode.toString(qrData, { type: "svg" });
        res.setHeader("Content-Type", "image/svg+xml");
        return res.send(svg);
      }
    });
  } catch (e) {
    res.status(500).send(e.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));
