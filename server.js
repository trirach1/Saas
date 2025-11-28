import express from "express";
import QRCode from "qrcode";
import { Boom } from "@hapi/boom";
import {
  makeWASocket,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  DisconnectReason
} from "@whiskeysockets/baileys";

const app = express();
app.use(express.json());

// Store active WhatsApp sessions
const sessions = {};

// ---------------- INIT SESSION ------------------

app.post("/init", async (req, res) => {
  try {
    const { profile } = req.body;

    if (!profile) return res.status(400).json({ error: "profile required" });

    console.log("Initializing WhatsApp for:", profile);

    const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${profile}`);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      browser: ["Railway", "Chrome", "1.0"],
      syncFullHistory: false,
    });

    sock.lastQR = null;       // for QR
    sock.pairCode = null;     // for pairing code

    sock.ev.on("creds.update", saveCreds);

    // Listen for connection updates
    sock.ev.on("connection.update", (update) => {
      const { qr, connection, lastDisconnect } = update;

      if (qr) {
        console.log("QR RECEIVED for", profile);
        sock.lastQR = qr;
      }

      if (connection === "open") {
        console.log("CONNECTED:", profile);
      }

      if (connection === "close") {
        const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
        console.log("DISCONNECTED:", reason);

        if (reason !== DisconnectReason.loggedOut) {
          console.log("Reconnecting...");
        }
      }
    });

    sessions[profile] = sock;

    return res.json({
      success: true,
      message: "client initializing",
      profile,
    });

  } catch (e) {
    console.error("INIT ERROR:", e);
    return res.status(500).json({ error: e.message });
  }
});

// ---------------- GET QR CODE ------------------

app.get("/qr", async (req, res) => {
  const profile = req.query.profile;
  if (!profile) return res.status(400).send("profile required");

  const sock = sessions[profile];
  if (!sock) return res.status(404).send("session not initialized");

  if (sock.lastQR) {
    const svg = await QRCode.toString(sock.lastQR, { type: "svg" });
    res.setHeader("Content-Type", "image/svg+xml");
    return res.send(svg);
  }

  res.status(408).send("QR timeout");
});

// ---------------- PAIRING CODE ENDPOINT ------------------

app.post("/pairing", async (req, res) => {
  try {
    const { profile, phone } = req.body;

    if (!profile) return res.status(400).json({ error: "profile required" });
    if (!phone) return res.status(400).json({ error: "phone required. format: 212612345678" });

    const sock = sessions[profile];
    if (!sock) return res.status(404).send("session not initialized");

    console.log("Requesting pairing code for:", phone);

    const pairingCode = await sock.requestPairingCode(phone);

    // Store it so frontend can fetch it
    sock.pairCode = pairingCode;

    return res.json({
      success: true,
      pairingCode,
    });

  } catch (e) {
    console.error("PAIRING ERROR:", e);
    return res.status(500).json({ error: e.message });
  }
});

// ---------------- GET PAIRING CODE ------------------

app.get("/pairing", (req, res) => {
  const profile = req.query.profile;

  const sock = sessions[profile];
  if (!sock) return res.status(404).send("session not initialized");

  if (!sock.pairCode) return res.status(404).send("pairing code not set yet");

  res.json({ pairingCode: sock.pairCode });
});

// ---------------- DEBUG ------------------

app.get("/debug", (req, res) => {
  res.json({
    sessions: Object.keys(sessions),
    qr: sessions["test-profile"]?.lastQR ? true : false,
    pairing: sessions["test-profile"]?.pairCode || null,
  });
});

// ---------------- HEALTH ------------------

app.get("/health", (req, res) => res.send("OK"));

app.listen(8080, () => console.log("WhatsApp Service running on port 8080"));
