import express from "express";
import QRCode from "qrcode";
import { Boom } from "@hapi/boom";
import fs from "fs";
import {
  makeWASocket,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  DisconnectReason
} from "@whiskeysockets/baileys";

const app = express();
app.use(express.json());

const sessions = {};
const connectedPhones = {};
const connectionStatus = {};
const sessionsQR = {};
const sessionsPairing = {};

async function createClient(profile, pairing = false) {

  const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${profile}`);
  const { version } = await fetchLatestBaileysVersion();

  // Always use WEB MODE (mobile mode removed 2024)
  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: pairing
      ? ["Desktop", "Safari", "15.6"]      // pairing mode supported browser
      : ["Chrome", "Linux", "10.15"],      // QR mode standard browser
  });

  sessions[profile] = sock;
  sessionsQR[profile] = null;
  sessionsPairing[profile] = null;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, qr, lastDisconnect, pairingCode } = update;

    // QR
    if (qr) {
      sessionsQR[profile] = qr;
      sessionsPairing[profile] = null;
      console.log("QR GENERATED:", profile);
    }

    // Pairing
    if (pairingCode) {
      sessionsPairing[profile] = pairingCode;
      sessionsQR[profile] = null;
      console.log("PAIRING CODE:", pairingCode);
    }

    // Connected
    if (connection === "open") {
      console.log("CONNECTED:", profile);
      connectionStatus[profile] = "open";
      sessionsQR[profile] = null;
      sessionsPairing[profile] = null;

      try {
        connectedPhones[profile] = sock.user?.id?.split(":")[0] || null;
      } catch {}
    }

    // Disconnected
    if (connection === "close") {
      connectionStatus[profile] = "closed";
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;

      // Logged out = delete session
      if (code === DisconnectReason.loggedOut) {
        console.log("LOGGED OUT:", profile);
        fs.rmSync(`./sessions/${profile}`, { recursive: true, force: true });

        delete sessions[profile];
        delete connectedPhones[profile];
        delete sessionsQR[profile];
        delete sessionsPairing[profile];

        return;
      }

      console.log("RECONNECTING:", profile);
      createClient(profile, pairing);
    }
  });
}

// INIT
app.post("/init", async (req, res) => {
  try {
    const { profile, pairing } = req.body;
    if (!profile) return res.status(400).json({ error: "profile required" });

    if (sessions[profile]) {
      sessions[profile].end();
    }

    await createClient(profile, pairing === true);

    res.json({ success: true, message: "Client initializing", profile });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Pairing Code
app.post("/pairing", async (req, res) => {
  const { profile, phone } = req.body;

  if (!profile) return res.status(400).json({ error: "profile required" });
  if (!phone) return res.status(400).json({ error: "phone required (212612345678)" });

  const sock = sessions[profile];
  if (!sock) return res.status(404).json({ error: "session not initialized" });

  try {
    const cleanPhone = String(phone).replace(/\D/g, "");
    const code = await sock.requestPairingCode(cleanPhone);
    return res.json({ success: true, pairing_code: code });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// QR
app.get("/qr", async (req, res) => {
  const profile = req.query.profile;
  if (!profile) return res.status(400).json({ error: "profile required" });

  if (!sessionsQR[profile])
    return res.status(404).json({ error: "QR not ready" });

  const svg = await QRCode.toString(sessionsQR[profile], { type: "svg" });
  res.setHeader("Content-Type", "image/svg+xml");
  return res.send(svg);
});

// STATUS
app.get("/status", (req, res) => {
  const profile = req.query.profile;
  const sock = sessions[profile];

  res.json({
    exists: !!sock,
    connected: connectionStatus[profile] === "open",
    phone: connectedPhones[profile] || null,
    qr_ready: !!sessionsQR[profile],
    pairing_ready: sessionsPairing[profile] || null,
  });
});

// Disconnect
app.post("/disconnect", (req, res) => {
  const { profile } = req.body;

  if (sessions[profile]) sessions[profile].end();

  fs.rmSync(`./sessions/${profile}`, { recursive: true, force: true });

  delete sessions[profile];
  delete connectedPhones[profile];
  delete sessionsQR[profile];
  delete sessionsPairing[profile];

  res.json({ success: true });
});

// Debug
app.get("/debug", (req, res) => {
  res.json({
    sessions: Object.keys(sessions),
    phones: connectedPhones,
    qr: sessionsQR,
    pairing: sessionsPairing,
    connectionStatus,
  });
});

app.listen(8080, "0.0.0.0", () =>
  console.log("WhatsApp Service running on port 8080")
);
