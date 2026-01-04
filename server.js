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
const reconnectAttempts = {};
const connectedPhones = {};
const connectionStatus = {};
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY = 5000;

async function createClient(profile, pairing = false) {
  console.log("Starting client:", profile, "pairing:", pairing);

  const sessionPath = `./sessions/${profile}`;
  if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    syncFullHistory: false,
    browser: pairing ? ["Android", "Chrome", "2.0"] : ["Web", "Chrome", "1.0"],
    mobile: false,
  });

  sock.lastQR = null;
  sock.lastPairingCode = null;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    console.log("Messages received:", type, "count:", messages.length);
    
    for (const msg of messages) {
      if (msg.key.fromMe) continue;

      const messageText = msg.message?.conversation || 
                          msg.message?.extendedTextMessage?.text ||
                          msg.message?.imageMessage?.caption ||
                          msg.message?.videoMessage?.caption ||
                          null;
      
      if (!messageText) continue;

      const from = msg.key.remoteJid;
      console.log(`New message from ${from}: ${messageText}`);

      try {
        const supabaseUrl = process.env.SUPABASE_URL || 'https://hrshudfqrjyrgppkiaas.supabase.co';
        const response = await fetch(`${supabaseUrl}/functions/v1/whatsapp-web-message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profile, from, message: messageText, messageId: msg.key.id })
        });

        if (response.ok) {
          const data = await response.json();
          if (data.reply) {
            try {
              await sock.sendMessage(from, { text: data.reply });
              console.log(`Sent reply to ${from}`);
            } catch (sendErr) {
              console.error('Send failed:', sendErr.message);
            }
          }
        }
      } catch (error) {
        console.error('Error processing message:', error.message);
      }
    }
  });

  sock.ev.on("connection.update", async (update) => {
    const { qr, connection, lastDisconnect, pairingCode } = update;

    if (qr) {
      console.log("QR received:", profile);
      sock.lastQR = qr;
      reconnectAttempts[profile] = 0;
    }

    if (pairingCode) {
      console.log("PAIRING CODE:", pairingCode);
      sock.lastPairingCode = pairingCode;
      reconnectAttempts[profile] = 0;
    }

    if (connection === "open") {
      console.log("CONNECTED:", profile);
      reconnectAttempts[profile] = 0;
      connectionStatus[profile] = "open";
      try {
        const phoneNumber = sock.user?.id?.split(':')[0] || sock.user?.id;
        if (phoneNumber) connectedPhones[profile] = phoneNumber;
      } catch (e) {}
    }

    if (connection === "close") {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log("Disconnected:", reason);
      connectionStatus[profile] = "closed";

      if (reason === DisconnectReason.loggedOut || reason === 428) {
        const sp = `./sessions/${profile}`;
        if (fs.existsSync(sp)) fs.rmSync(sp, { recursive: true, force: true });
        delete sessions[profile];
        delete reconnectAttempts[profile];
        delete connectedPhones[profile];
        delete connectionStatus[profile];
        return;
      }

      if (!reconnectAttempts[profile]) reconnectAttempts[profile] = 0;
      if (reconnectAttempts[profile] >= MAX_RECONNECT_ATTEMPTS) return;

      reconnectAttempts[profile]++;
      setTimeout(() => createClient(profile, pairing), RECONNECT_DELAY * reconnectAttempts[profile]);
    }
  });

  sessions[profile] = sock;
  return sock;
}

app.post("/init", async (req, res) => {
  try {
    const { profile, pairing } = req.body;
    if (!profile) return res.status(400).json({ error: "profile required" });

    if (sessions[profile]) {
      try { sessions[profile].end(); } catch (e) {}
      delete sessions[profile];
    }
    reconnectAttempts[profile] = 0;

    await createClient(profile, pairing === true);
    return res.json({ success: true, message: "client initializing", profile });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.post("/pairing", async (req, res) => {
  try {
    const { profile, phone } = req.body;
    if (!profile) return res.status(400).json({ error: "profile required" });
    if (!phone) return res.status(400).json({ error: "phone required" });

    const sock = sessions[profile];
    if (!sock) return res.status(404).json({ error: "session not initialized" });

    const cleanPhone = String(phone).replace(/\D/g, '');
    const code = await sock.requestPairingCode(cleanPhone);
    return res.json({ success: true, pairing_code: code });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get("/qr", async (req, res) => {
  const profile = req.query.profile;
  if (!profile) return res.status(400).json({ error: "profile required" });
  const sock = sessions[profile];
  if (!sock) return res.status(404).json({ error: "session not initialized" });
  if (sock.lastQR) {
    const svg = await QRCode.toString(sock.lastQR, { type: "svg" });
    res.setHeader("Content-Type", "image/svg+xml");
    return res.send(svg);
  }
  return res.status(404).json({ error: "QR not ready" });
});

app.get("/status", (req, res) => {
  const profile = req.query.profile;
  if (!profile) return res.status(400).json({ error: "profile required" });
  const sock = sessions[profile];
  if (!sock) return res.json({ connected: false, exists: false });
  return res.json({
    success: true,
    connected: connectionStatus[profile] === "open",
    exists: true,
    phone: connectedPhones[profile] || null,
    hasQR: !!sock.lastQR,
    hasPairing: !!sock.lastPairingCode,
    pairing: sock.lastPairingCode || null
  });
});

app.post("/send-message", async (req, res) => {
  try {
    const { profile, to, message } = req.body;
    if (!profile || !to || !message) return res.json({ success: false, error: "missing params" });

    let sock = sessions[profile];
    if (!sock) {
      try { sock = await createClient(profile, false); } 
      catch (e) { return res.json({ success: false, error: "session not found" }); }
    }
    if (connectionStatus[profile] !== "open") {
      return res.json({ success: false, error: "not connected" });
    }

    const digits = String(to).replace(/\D/g, "");
    const jid = `${digits}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    return res.json({ success: true, to: jid });
  } catch (e) {
    return res.json({ success: false, error: e.message });
  }
});

app.post("/disconnect", (req, res) => {
  const { profile } = req.body;
  if (!profile) return res.status(400).json({ error: "profile required" });
  const sock = sessions[profile];
  if (sock) {
    try { sock.end(); } catch (e) {}
    delete sessions[profile];
  }
  delete reconnectAttempts[profile];
  delete connectedPhones[profile];
  delete connectionStatus[profile];
  const sp = `./sessions/${profile}`;
  if (fs.existsSync(sp)) fs.rmSync(sp, { recursive: true, force: true });
  return res.json({ success: true });
});

app.get("/debug", (req, res) => {
  res.json({ sessions: Object.keys(sessions), phones: connectedPhones, status: connectionStatus });
});

app.get("/health", (req, res) => res.send("OK"));

app.listen(8080, "0.0.0.0", () => console.log("WhatsApp Service running on port 8080"));
