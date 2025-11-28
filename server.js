import express from "express";
import QRCode from "qrcode";
import { Boom } from "@hapi/boom";
import {
  makeWASocket,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  DisconnectReason
} from "@whiskeysockets/baileys";
import fs from "fs";

const app = express();
app.use(express.json());

const sessions = {};
const reconnectAttempts = {}; // Track reconnection attempts
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY = 5000; // 5 seconds

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
    browser: ["AutomateAI", "Chrome", "1.0"],
    mobile: false, // Must be disabled
  });

  sock.lastQR = null;
  sock.lastPairingCode = null;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { qr, connection, lastDisconnect, pairingCode } = update;

    if (qr) {
      console.log("QR received:", profile);
      sock.lastQR = qr;
      reconnectAttempts[profile] = 0; // Reset attempts on new QR
    }

    if (pairingCode) {
      console.log("PAIRING CODE:", pairingCode);
      sock.lastPairingCode = pairingCode;
      reconnectAttempts[profile] = 0; // Reset attempts on pairing
    }

    if (connection === "open") {
      console.log("✅ CONNECTED:", profile);
      reconnectAttempts[profile] = 0; // Reset on successful connection
    }

    if (connection === "close") {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log("❌ Disconnected:", reason, "Profile:", profile);

      // Don't reconnect if logged out or too many attempts
      if (reason === DisconnectReason.loggedOut) {
        console.log("Logged out - cleaning up session:", profile);
        delete sessions[profile];
        delete reconnectAttempts[profile];
        return;
      }

      // Check reconnection attempts
      if (!reconnectAttempts[profile]) reconnectAttempts[profile] = 0;
      reconnectAttempts[profile]++;

      if (reconnectAttempts[profile] > MAX_RECONNECT_ATTEMPTS) {
        console.error(`❌ Max reconnect attempts reached for ${profile}. Stopping.`);
        delete sessions[profile];
        delete reconnectAttempts[profile];
        return;
      }

      // Handle 428 (Precondition Required) - usually rate limiting
      if (reason === 428) {
        console.log(`⚠️  Rate limited (428). Waiting longer before retry ${reconnectAttempts[profile]}/${MAX_RECONNECT_ATTEMPTS}`);
        
        // Clean session data and wait longer
        const sessionPath = `./sessions/${profile}`;
        if (fs.existsSync(sessionPath)) {
          fs.rmSync(sessionPath, { recursive: true, force: true });
        }
        
        setTimeout(async () => {
          console.log("Retrying after 428...", profile);
          await createClient(profile, pairing);
        }, RECONNECT_DELAY * reconnectAttempts[profile]); // Exponential backoff
        return;
      }

      // For other disconnect reasons, wait before reconnecting
      console.log(`Reconnecting in ${RECONNECT_DELAY}ms (attempt ${reconnectAttempts[profile]}/${MAX_RECONNECT_ATTEMPTS})...`);
      setTimeout(async () => {
        await createClient(profile, pairing);
      }, RECONNECT_DELAY);
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

    // Clean up existing session if any
    if (sessions[profile]) {
      console.log("Cleaning up existing session:", profile);
      sessions[profile].end();
      delete sessions[profile];
    }

    // Reset reconnect attempts
    reconnectAttempts[profile] = 0;

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

  if (!sock) return res.status(404).json({ error: "session not initialized" });

  if (sock.lastQR) {
    const svg = await QRCode.toString(sock.lastQR, { type: "svg" });
    res.setHeader("Content-Type", "image/svg+xml");
    return res.send(svg);
  }

  return res.status(404).json({ error: "QR not ready yet, please wait" });
});

// -------------------------------------------
// DISCONNECT
// -------------------------------------------
app.post("/disconnect", (req, res) => {
  const { profile } = req.body;
  if (!profile) return res.status(400).json({ error: "profile required" });

  const sock = sessions[profile];
  if (sock) {
    sock.end();
    delete sessions[profile];
    delete reconnectAttempts[profile];
    
    // Clean session data
    const sessionPath = `./sessions/${profile}`;
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }
  }

  return res.json({ success: true });
});

// -------------------------------------------
// STATUS
// -------------------------------------------
app.get("/status", (req, res) => {
  const profile = req.query.profile;
  if (!profile) return res.status(400).json({ error: "profile required" });

  const sock = sessions[profile];
  return res.json({
    exists: !!sock,
    connected: sock?.ws?.readyState === 1,
    hasQR: !!sock?.lastQR,
    hasPairing: !!sock?.lastPairingCode,
    attempts: reconnectAttempts[profile] || 0
  });
});

// DEBUG
app.get("/debug", (req, res) => {
  res.json({
    sessions: Object.keys(sessions),
    reconnectAttempts,
    qr: sessions["test-profile"]?.lastQR ? true : false,
    pairing: sessions["test-profile"]?.lastPairingCode || null,
    ws: sessions["test-profile"]?.ws?.readyState || "no ws"
  });
});

// HEALTH
app.get("/health", (req, res) => res.json({ status: "healthy", sessions: Object.keys(sessions).length }));

app.listen(8080, "0.0.0.0", () => console.log("✅ WhatsApp Service running on port 8080"));
