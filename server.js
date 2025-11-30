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
const connectedPhones = {}; // Store connected phone numbers
const connectionStatus = {}; // Track actual connection status
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY = 5000;

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
    // Use WhatsApp mobile-style session when using pairing codes
    browser: pairing ? ["Android", "Chrome", "2.0"] : ["Web", "Chrome", "1.0"],
    mobile: false,
  });

  sock.lastQR = null;
  sock.lastPairingCode = null;

  sock.ev.on("creds.update", saveCreds);

  // Handle incoming messages
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    console.log("Messages received:", type);
    
    for (const msg of messages) {
      // Skip if message is from us or has no text
      if (msg.key.fromMe || !msg.message?.conversation) {
        continue;
      }

      const from = msg.key.remoteJid; // sender's number
      const messageText = msg.message.conversation;
      
      console.log(`New message from ${from}: ${messageText}`);

      try {
        // Forward to Supabase edge function for AI processing
        const supabaseUrl = process.env.SUPABASE_URL || 'https://hrshudfqrjyrgppkiaas.supabase.co';
        const webhookUrl = `${supabaseUrl}/functions/v1/whatsapp-web-message`;
        
        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            profile,
            from,
            message: messageText,
            messageId: msg.key.id
          })
        });

        if (response.ok) {
          const data = await response.json();
          
          // Send AI response back via WhatsApp
          if (data.reply) {
            await sock.sendMessage(from, { text: data.reply });
            console.log(`Sent reply to ${from}`);
          }
        } else {
          console.error('Webhook error:', response.status, await response.text());
        }
      } catch (error) {
        console.error('Error processing message:', error);
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
      
      // Store the connected phone number
      try {
        const phoneNumber = sock.user?.id?.split(':')[0] || sock.user?.id;
        if (phoneNumber) {
          connectedPhones[profile] = phoneNumber;
          console.log("Connected phone:", phoneNumber);
        }
      } catch (error) {
        console.error("Error getting phone number:", error);
      }
    }

    if (connection === "close") {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log("Disconnected:", reason);

      if (reason === DisconnectReason.loggedOut) {
        console.log("Logged out, cleaning session:", profile);
        const sessionPath = `./sessions/${profile}`;
        if (fs.existsSync(sessionPath)) {
          fs.rmSync(sessionPath, { recursive: true, force: true });
        }
        delete sessions[profile];
        delete reconnectAttempts[profile];
        delete connectedPhones[profile];
        delete connectionStatus[profile];
        return;
      }

      if (!reconnectAttempts[profile]) {
        reconnectAttempts[profile] = 0;
      }

      if (reconnectAttempts[profile] >= MAX_RECONNECT_ATTEMPTS) {
        console.log("Max reconnect attempts reached for:", profile);
        delete connectedPhones[profile];
        delete connectionStatus[profile];
        return;
      }

      reconnectAttempts[profile]++;
      console.log(`Reconnecting... (${reconnectAttempts[profile]}/${MAX_RECONNECT_ATTEMPTS})`, profile);

      if (reason === 428) {
        console.log("Rate limited (428), cleaning session and waiting longer");
        const sessionPath = `./sessions/${profile}`;
        if (fs.existsSync(sessionPath)) {
          fs.rmSync(sessionPath, { recursive: true, force: true });
        }
        delete connectedPhones[profile];
        delete connectionStatus[profile];
        
        setTimeout(() => {
          createClient(profile, pairing);
        }, RECONNECT_DELAY * 3);
      } else {
        setTimeout(() => {
          createClient(profile, pairing);
        }, RECONNECT_DELAY * reconnectAttempts[profile]);
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

    // Clean up existing session
    if (sessions[profile]) {
      sessions[profile].end();
      delete sessions[profile];
    }
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

    // Clean and log phone number in international format (digits only)
    const cleanPhone = String(phone).replace(/\D/g, '');
    console.log("Requesting pairing code for:", cleanPhone);

    const code = await sock.requestPairingCode(cleanPhone);

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

  if (!profile) return res.status(400).json({ error: "profile required" });

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
// STATUS ENDPOINT
// -------------------------------------------
app.get("/status", (req, res) => {
  const profile = req.query.profile;
  if (!profile) return res.status(400).json({ error: "profile required" });

  const sock = sessions[profile];
  if (!sock) {
    return res.status(404).json({ 
      error: "session not found",
      connected: false,
      exists: false
    });
  }

  // Use the tracked connection status instead of WebSocket state
  const isConnected = connectionStatus[profile] === "open";

  return res.json({
    success: true,
    connected: isConnected,
    exists: true,
    connection: isConnected ? "open" : "closed",
    phone: connectedPhones[profile] || null,
    hasQR: !!sock.lastQR,
    hasPairing: !!sock.lastPairingCode,
    qr: sock.lastQR ? true : false,
    pairing: sock.lastPairingCode || null,
    reconnectAttempts: reconnectAttempts[profile] || 0
  });
});

// -------------------------------------------
// DISCONNECT ENDPOINT
// -------------------------------------------
app.post("/disconnect", (req, res) => {
  const { profile } = req.body;
  if (!profile) return res.status(400).json({ error: "profile required" });

  const sock = sessions[profile];
  if (!sock) {
    return res.status(404).json({ error: "session not found" });
  }

  sock.end();
  delete sessions[profile];
  delete reconnectAttempts[profile];
  delete connectedPhones[profile];
  delete connectionStatus[profile];

  const sessionPath = `./sessions/${profile}`;
  if (fs.existsSync(sessionPath)) {
    fs.rmSync(sessionPath, { recursive: true, force: true });
  }

  return res.json({ success: true, message: "session disconnected" });
});

// DEBUG
app.get("/debug", (req, res) => {
  res.json({
    sessions: Object.keys(sessions),
    phones: connectedPhones,
    connectionStatus: connectionStatus,
    reconnectAttempts: reconnectAttempts
  });
});

// HEALTH
app.get("/health", (req, res) => res.send("OK"));

app.listen(8080, "0.0.0.0", () => console.log("WhatsApp Service running on port 8080"));
