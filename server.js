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

// Store active sessions
const sessions = {};


// ==================================================
// CREATE WHATSAPP CLIENT
// ==================================================
async function createClient(profile, pairing = false) {
  console.log(`Starting client: ${profile}, pairing: ${pairing}`);

  const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${profile}`);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ["Chrome", "Safari", "10.0"],
    // ❌ mobile is removed (deprecated)
    // mobile: pairing ? true : false,
  });

  sock.lastQR = null;
  sock.lastPairingCode = null;
  sock.pairingRequested = false;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr, pairingCode } = update;

    if (qr && !pairing) {
      console.log(`QR received for ${profile}`);
      sock.lastQR = qr;
    }

    if (pairingCode) {
      console.log("Pairing code received:", pairingCode);
      sock.lastPairingCode = pairingCode;
    }

    if (connection === "open") {
      console.log(`CONNECTED: ${profile}`);
    }

    if (connection === "close") {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log(`Disconnected: ${statusCode}`);

      if (statusCode !== DisconnectReason.loggedOut) {
        console.log(`Reconnecting ${profile}...`);
        setTimeout(() => createClient(profile, pairing), 2000);
      }
    }
  });

  sessions[profile] = sock;
  return sock;
}


// ==================================================
// INIT SESSION (QR OR PAIRING)
// ==================================================
app.post("/init", async (req, res) => {
  try {
    const { profile, pairing } = req.body;

    if (!profile) return res.status(400).json({ error: "profile required" });

    await createClient(profile, pairing === true);

    return res.json({
      success: true,
      message: "Client initializing",
      profile
    });
  } catch (err) {
    console.error("INIT ERROR:", err);
    return res.status(500).json({ error: err.message });
  }
});


// ==================================================
// GET PAIRING CODE
// ==================================================
app.post("/pairing", async (req, res) => {
  try {
    const { profile, phone } = req.body;

    if (!profile) return res.status(400).json({ error: "profile required" });
    if (!phone) return res.status(400).json({ error: "phone required" });

    const sock = sessions[profile];
    if (!sock) return res.status(404).json({ error: "session not initialized" });

    console.log("Requesting pairing code for:", phone);

    let code;

    try {
      code = await sock.requestPairingCode(phone);
    } catch (err) {
      console.log("PAIRING ERROR:", err);
      return res.status(428).json({ error: "Connection not ready yet" });
    }

    return res.json({ success: true, pairing_code: code });
  } catch (err) {
    console.error("PAIRING ERROR:", err);
    return res.status(500).json({ error: "Internal error" });
  }
});


// ==================================================
// GET QR SVG
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
// HEALTHCHECK FOR RAILWAY
// ==================================================
app.get("/health", (req, res) => res.send("OK"));


// ==================================================
// START SERVER
// ==================================================
const PORT = process.env.PORT || 8080;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`WhatsApp Service running on port ${PORT}`);
});
