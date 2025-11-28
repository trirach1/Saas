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

// -------------------------------------------
// CREATE CLIENT (QR + PAIRING)
// -------------------------------------------
async function createClient(profile, pairing = false) {
  console.log("Starting client:", profile, "pairing:", pairing);

  const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${profile}`);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    syncFullHistory: false,
    browser: ["Web", "Chrome", "1.0"],

    // ❗ VERY IMPORTANT — MUST BE DISABLED
    mobile: false, 
  });

  sock.lastQR = null;
  sock.lastPairingCode = null;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { qr, connection, lastDisconnect, pairingCode } = update;

    if (qr) {
      console.log("QR received:", profile);
      sock.lastQR = qr;
    }

    if (pairingCode) {
      console.log("PAIRING CODE:", pairingCode);
      sock.lastPairingCode = pairingCode;
    }

    if (connection === "open") {
      console.log("CONNECTED:", profile);
    }

    if (connection === "close") {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log("Disconnected:", reason);

      if (reason !== DisconnectReason.loggedOut) {
        console.log("Reconnecting...", profile);
        await createClient(profile, pairing);
      }
    }
  });

  sessions[profile] = sock;
  return sock;
}

// -------------------------------------------
// INIT CLIENT
// -------------------------------------------
app.post("/init", async (req, res) => {
  try {
    const { profile, pairing } = req.body;
    if (!profile) return res.status(400).json({ error: "profile required" });

    await createClient(profile, pairing === true);

    return res.json({ success: true, message: "client initializing", profile });

  } catch (e) {
    console.error("INIT ERROR:", e);
    return res.status(500).json({ error: e.message });
  }
});

// -------------------------------------------
// PAIRING CODE REQUEST
// -------------------------------------------
app.post("/pairing", async (req, res) => {
  try {
    const { profile, phone } = req.body;

    if (!profile) return res.status(400).json({ error: "profile required" });
    if (!phone) return res.status(400).json({ error: "phone required, ex: 212612345678" });

    const sock = sessions[profile];
    if (!sock) return res.status(404).json({ error: "session not initialized" });

    console.log("Requesting pairing code for:", phone);

    const code = await sock.requestPairingCode(phone);

    if (!code) return res.status(500).json({ error: "failed to generate pairing code" });

    return res.json({ success: true, pairing_code: code });

  } catch (e) {
    console.log("PAIRING ERROR:", e);
    return res.status(500).json({ error: e.message });
  }
});

// -------------------------------------------
// QR ENDPOINT
// -------------------------------------------
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

  return res.status(404).send("No QR available yet");
});

// DEBUG
app.get("/debug", (req, res) => {
  res.json({
    sessions: Object.keys(sessions),
    qr: sessions["test-profile"]?.lastQR ? true : false,
    pairing: sessions["test-profile"]?.lastPairingCode || null,
    ws: sessions["test-profile"]?.ws?.readyState || "no ws"
  });
});

// HEALTH
app.get("/health", (req, res) => res.send("OK"));

app.listen(8080, () => console.log("WhatsApp Service running on port 8080"));
