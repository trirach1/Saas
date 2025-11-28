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
    const { profile } = req.body;

    const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${profile}`);

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      if (update.qr) {
        sock.lastQR = update.qr;
      }
    });

    sessions[profile] = sock;

    return res.json({
      success: true,
      message: "Client initializing",
      profile
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// RETURN QR CODE
// QR ENDPOINT (FULLY FIXED)
app.get("/qr", async (req, res) => {
  try {
    const profile = req.query.profile;

    if (!profile) return res.status(400).send("profile is required");
    if (!sessions[profile]) return res.status(404).send("session not initialized");

    const sock = sessions[profile];

    // If QR already exists, send instantly
    if (sock.lastQR) {
      const svg = await QRCode.toString(sock.lastQR, { type: "svg" });
      res.setHeader("Content-Type", "image/svg+xml");
      return res.send(svg);
    }

    // Otherwise wait for new QR
    sock.ev.on("connection.update", async (update) => {
      if (update.qr) {
        sock.lastQR = update.qr; // store for next request
        const svg = await QRCode.toString(update.qr, { type: "svg" });
        res.setHeader("Content-Type", "image/svg+xml");
        return res.send(svg);
      }
    });

    // Timeout safeguard
    setTimeout(() => {
      if (!sock.lastQR) {
        res.status(408).send("QR timeout");
      }
    }, 10000);
  } catch (e) {
    res.status(500).send(e.message);
  }
});
app.get("/debug", (req, res) => {
  res.json({
    sessions: Object.keys(sessions),
    hasQR: sessions["test-profile"]?.lastQR ? true : false,
    status: sessions["test-profile"]?.ws?.readyState || "no ws"
  });
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));
