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

// Database persistence for sessions
async function saveSessionToDatabase(profile, sessionData) {
  try {
    const supabaseUrl = process.env.SUPABASE_URL || 'https://hrshudfqrjyrgppkiaas.supabase.co';
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhyc2h1ZGZxcmp5cmdwcGtpYWFzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjAwNjk1NDQsImV4cCI6MjA3NTY0NTU0NH0.8e9qC2X5jHkboIR4FJJfPwN7twM-z1a1-aoDVvsJY0Y';
    
    if (!supabaseKey) {
      console.log('No service role key, skipping session persistence');
      return;
    }

    await fetch(`${supabaseUrl}/rest/v1/whatsapp_web_sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({
        profile_id: profile,
        session_data: sessionData,
        connected_phone: connectedPhones[profile] || null,
        connection_status: connectionStatus[profile] || 'disconnected',
        updated_at: new Date().toISOString()
      })
    });
    console.log('Session saved to database for:', profile);
  } catch (error) {
    console.error('Error saving session to database:', error.message);
  }
}

async function restoreSessionsFromDatabase() {
  try {
    const supabaseUrl = process.env.SUPABASE_URL || 'https://hrshudfqrjyrgppkiaas.supabase.co';
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    
    if (!supabaseKey) {
      console.log('No service role key, skipping session restoration');
      return;
    }

    const response = await fetch(`${supabaseUrl}/rest/v1/whatsapp_web_sessions?connection_status=eq.connected&select=*`, {
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`
      }
    });

    if (response.ok) {
      const savedSessions = await response.json();
      console.log(`Found ${savedSessions.length} sessions to restore`);
      
      for (const session of savedSessions) {
        try {
          console.log('Attempting to restore session:', session.profile_id);
          await createClient(session.profile_id, false);
        } catch (error) {
          console.error('Failed to restore session:', session.profile_id, error.message);
        }
      }
    }
  } catch (error) {
    console.error('Error restoring sessions from database:', error.message);
  }
}

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

  sock.ev.on("creds.update", async () => {
    await saveCreds();
    try {
      const sessionFiles = fs.readdirSync(sessionPath);
      const sessionData = {};
      for (const file of sessionFiles) {
        const content = fs.readFileSync(`${sessionPath}/${file}`, 'utf8');
        sessionData[file] = content;
      }
      await saveSessionToDatabase(profile, sessionData);
    } catch (e) {
      console.error('Error reading session files:', e.message);
    }
  });

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
        await saveSessionToDatabase(profile, null);
      } catch (e) {
        console.error('Error on connection open:', e.message);
      }
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
        await saveSessionToDatabase(profile, null);
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
    const profile = req.body.profile || req.body.profileId;
    const pairing = req.body.pairing;
    const phoneNumber = req.body.phoneNumber;
    
    if (!profile) return res.status(400).json({ error: "profile required" });

    if (sessions[profile]) {
      try { sessions[profile].end(); } catch (e) {}
      delete sessions[profile];
    }
    reconnectAttempts[profile] = 0;

    await createClient(profile, pairing === true);
    
    if (pairing && phoneNumber) {
      const sock = sessions[profile];
      if (sock) {
        const cleanPhone = String(phoneNumber).replace(/\D/g, '');
        try {
          const code = await sock.requestPairingCode(cleanPhone);
          return res.json({ success: true, message: "client initializing with pairing", profile, pairing_code: code });
        } catch (e) {
          console.error('Pairing code request failed:', e.message);
        }
      }
    }
    
    return res.json({ success: true, message: "client initializing", profile });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.post("/pairing", async (req, res) => {
  try {
    const profile = req.body.profile || req.body.profileId;
    const phone = req.body.phone || req.body.phoneNumber;
    
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
  const profile = req.query.profile || req.query.profileId;
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
  const profile = req.query.profile || req.query.profileId;
  if (!profile) return res.status(400).json({ error: "profile required" });
  
  const sock = sessions[profile];
  if (!sock) return res.json({ connected: false, exists: false });
  
  return res.json({
    success: true,
    connected: connectionStatus[profile] === "open",
    connection: connectionStatus[profile] === "open" ? "open" : "closed",
    exists: true,
    phone: connectedPhones[profile] || null,
    hasQR: !!sock.lastQR,
    hasPairing: !!sock.lastPairingCode,
    pairing: sock.lastPairingCode || null
  });
});

app.post("/send-message", async (req, res) => {
  try {
    const profile = req.body.profile || req.body.profileId;
    const { to, message } = req.body;
    
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

app.post("/disconnect", async (req, res) => {
  const profile = req.body.profile || req.body.profileId;
  if (!profile) return res.status(400).json({ error: "profile required" });
  
  const sock = sessions[profile];
  if (sock) {
    try { sock.end(); } catch (e) {}
    delete sessions[profile];
  }
  delete reconnectAttempts[profile];
  delete connectedPhones[profile];
  connectionStatus[profile] = "disconnected";
  
  await saveSessionToDatabase(profile, null);
  
  const sp = `./sessions/${profile}`;
  if (fs.existsSync(sp)) fs.rmSync(sp, { recursive: true, force: true });
  
  delete connectionStatus[profile];
  return res.json({ success: true });
});

app.get("/debug", (req, res) => {
  res.json({ sessions: Object.keys(sessions), phones: connectedPhones, status: connectionStatus });
});

app.get("/health", (req, res) => res.send("OK"));

app.listen(8080, "0.0.0.0", () => {
  console.log("WhatsApp Service running on port 8080");
  setTimeout(restoreSessionsFromDatabase, 3000);
});
