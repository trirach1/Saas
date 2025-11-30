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

const sessions = {};

// ==================================================
// CREATE CLIENT
// ==================================================
async function createClient(profile, pairing = false, phone = null) {
  console.log(`Starting client: ${profile}, pairing: ${pairing}`);

  const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${profile}`);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    syncFullHistory: false,

    // PAIRING MODE (MOBILE=true)
    mobile: pairing ? true : false,

    browser: ["WA-SaaS", "Chrome", "1.0"]
  });

  sock.lastQR = null;
  sock.lastPairingCode = null;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { qr, connection, lastDisconnect, pairingCode } = update;

    if (qr) {
      console.log("QR received for:", profile);
      sock.lastQR = qr;
    }

    if (pairingCode) {
      console.log("Pairing code:", pairingCode);
      sock.lastPairingCode = pairingCode;
    }

    if (connection === "open") {
      console.log("CONNECTED:", profile);
    }

    if (connection === "close") {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log("Disconnected:", reason);

      if (reason !== DisconnectReason.loggedOut) {
        console.log("Reconnecting client:", profile);
        await createClient(profile, pairing, phone);
      }
    }
  });

  sessions[profile] = sock;
  return sock;
}

// ==================================================
// INIT (QR or PAIRING)
// ==================================================
app.post("/init", async (req, res) => {
  try {
    const { profile, pairing } = req.body;

    if (!profile)
      return res.status(400).json({ error: "profile required" });

    await createClient(profile, pairing === true);

    return res.json({
      success: true,
      message: "Client initializing...",
      profile
    });
  } catch (e) {
    console.error("INIT ERROR:", e);
    return res.status(500).json({ error: e.message });
  }
});

// ==================================================
// PAIRING CODE
// ==================================================
app.post("/pairing", async (req, res) => {
  try {
    const { profile, phone } = req.body;

    if (!profile) return res.status(400).json({ error: "profile required" });
    if (!phone) return res.status(400).json({ error: "phone required" });

    const sock = sessions[profile];
    if (!sock) return res.status(404).json({ error: "session not initialized" });

    console.log("Requesting pairing code for:", phone);

    const code = await sock.requestPairingCode(phone);

    if (!code) return res.status(500).json({ error: "pairing failed" });

    return res.json({ success: true, pairing_code: code });
  } catch (e) {
    console.error("PAIRING ERROR:", e);
    return res.status(500).json({ error: "Connection Closed" });
  }
});

// ==================================================
// QR IMAGE
// ==================================================
app.get("/qr", async (req, res) => {
  const profile = req.query.profile;
  if (!profile) return res.status(400).send("profile required");

  const sock = sessions[profile];
  if (!sock) return res.status(404).send("session not initialized");

  if (!sock.lastQR) return res.status(404).send("No QR available yet");

  const svg = await QRCode.toString(sock.lastQR, { type: "svg" });
  res.setHeader("Content-Type", "image/svg+xml");
  return res.send(svg);
});

// ==================================================
// DEBUG
// ==================================================
app.get("/debug", (req, res) => {
  res.json({
    sessions: Object.keys(sessions),
    qrAvailable: sessions["test-profile"]?.lastQR ? true : false,
    lastPairingCode: sessions["test-profile"]?.lastPairingCode || null
  });
});

// ==================================================
// HEALTHCHECK (REQUIRED FOR RAILWAY)
// ==================================================
app.get("/", (req, res) => {
  res.send("OK");
});

// ==================================================
// SERVER START
// ==================================================
const PORT = process.env.PORT || 8080;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`WhatsApp Service running on port ${PORT}`);
});
