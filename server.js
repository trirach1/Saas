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
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY = 5000;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://hrshudfqrjyrgppkiaas.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhyc2h1ZGZxcmp5cmdwcGtpYWFzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjAwNjk1NDQsImV4cCI6MjA3NTY0NTU0NH0.8e9qC2X5jHkboIR4FJJfPwN7twM-z1a1-aoDVvsJY0Y';

// -------------------------------------------
// SAVE SESSION TO DATABASE (for persistence across restarts)
// -------------------------------------------
async function saveSessionToDatabase(profile, sessionData, phone) {
  try {
    if (!SUPABASE_SERVICE_KEY) {
      console.log("No service key, skipping database save");
      return;
    }

    const response = await fetch(`${SUPABASE_URL}/functions/v1/whatsapp-session-persist`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
      },
      body: JSON.stringify({
        action: 'save',
        profileId: profile,
        sessionData,
        connectedPhone: phone
      })
    });

    if (response.ok) {
      console.log("Session saved to database for:", profile);
    } else {
      console.error("Failed to save session:", await response.text());
    }
  } catch (error) {
    console.error("Error saving session to database:", error);
  }
}

// -------------------------------------------
// RESTORE SESSIONS FROM DATABASE ON STARTUP
// -------------------------------------------
async function restoreSessionsFromDatabase() {
  try {
    if (!SUPABASE_SERVICE_KEY) {
      console.log("No service key, skipping session restore");
      return;
    }

    console.log("Attempting to restore sessions from database...");

    const response = await fetch(`${SUPABASE_URL}/functions/v1/whatsapp-session-persist`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
      },
      body: JSON.stringify({ action: 'list' })
    });

    if (!response.ok) {
      console.error("Failed to list sessions:", await response.text());
      return;
    }

    const data = await response.json();
    const profiles = data.profiles || [];

    console.log(`Found ${profiles.length} session(s) to restore`);

    for (const profileId of profiles) {
      try {
        console.log(`Restoring session for: ${profileId}`);
        
        // Fetch session data
        const sessionResponse = await fetch(`${SUPABASE_URL}/functions/v1/whatsapp-session-persist`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
          },
          body: JSON.stringify({ action: 'get', profileId })
        });

        if (!sessionResponse.ok) {
          console.error(`Failed to get session for ${profileId}`);
          continue;
        }

        const sessionData = await sessionResponse.json();
        
        if (sessionData.sessionData) {
          // Write session files
          const sessionPath = `./sessions/${profileId}`;
          if (!fs.existsSync(sessionPath)) {
            fs.mkdirSync(sessionPath, { recursive: true });
          }

          // Write each credential file
          for (const [filename, content] of Object.entries(sessionData.sessionData)) {
            fs.writeFileSync(`${sessionPath}/${filename}`, JSON.stringify(content));
          }

          // Create client with restored session
          await createClient(profileId, false);
          console.log(`Session restored for: ${profileId}`);
        }
      } catch (err) {
        console.error(`Error restoring session for ${profileId}:`, err);
      }
    }
  } catch (error) {
    console.error("Error restoring sessions from database:", error);
  }
}

// -------------------------------------------
// CREATE CLIENT (QR + PAIRING)
// -------------------------------------------
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
    // Use WhatsApp mobile-style session when using pairing codes
    browser: pairing ? ["Android", "Chrome", "2.0"] : ["Web", "Chrome", "1.0"],
    mobile: pairing,
  });

  sock.lastQR = null;
  sock.lastPairingCode = null;

  sock.ev.on("creds.update", async () => {
    await saveCreds();
    
    // Also save to database for persistence across Railway restarts
    try {
      const files = fs.readdirSync(sessionPath);
      const sessionData = {};
      for (const file of files) {
        const content = fs.readFileSync(`${sessionPath}/${file}`, 'utf8');
        try {
          sessionData[file] = JSON.parse(content);
        } catch {
          sessionData[file] = content;
        }
      }
      await saveSessionToDatabase(profile, sessionData, connectedPhones[profile]);
    } catch (err) {
      console.error("Error reading session files for backup:", err);
    }
  });

  // Handle incoming messages
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    console.log("Messages received:", type, "count:", messages.length);
    
    for (const msg of messages) {
      // Skip if message is from us
      if (msg.key.fromMe) {
        console.log("Skipping own message");
        continue;
      }

      // Extract text from various message formats
      const messageText = msg.message?.conversation || 
                          msg.message?.extendedTextMessage?.text ||
                          msg.message?.imageMessage?.caption ||
                          msg.message?.videoMessage?.caption ||
                          null;
      
      if (!messageText) {
        console.log("Skipping message without text content:", JSON.stringify(msg.message));
        continue;
      }

      const from = msg.key.remoteJid; // sender's number
      
      console.log(`New message from ${from}: ${messageText}`);

      try {
        // Forward to Supabase edge function for AI processing
        const webhookUrl = `${SUPABASE_URL}/functions/v1/whatsapp-web-message`;
        
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
          
          // Save session with phone number
          const sessionPath = `./sessions/${profile}`;
          if (fs.existsSync(sessionPath)) {
            const files = fs.readdirSync(sessionPath);
            const sessionData = {};
            for (const file of files) {
              const content = fs.readFileSync(`${sessionPath}/${file}`, 'utf8');
              try {
                sessionData[file] = JSON.parse(content);
              } catch {
                sessionData[file] = content;
              }
            }
            await saveSessionToDatabase(profile, sessionData, phoneNumber);
          }
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
        
        // Also remove from database
        try {
          await fetch(`${SUPABASE_URL}/functions/v1/whatsapp-session-persist`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
            },
            body: JSON.stringify({ action: 'delete', profileId: profile })
          });
        } catch (err) {
          console.error("Error deleting session from database:", err);
        }
        return;
      }

      if (!reconnectAttempts[profile]) {
        reconnectAttempts[profile] = 0;
      }

      if (reconnectAttempts[profile] >= MAX_RECONNECT_ATTEMPTS) {
        console.log("Max reconnect attempts reached for:", profile);
        connectionStatus[profile] = "disconnected";
        return;
      }

      reconnectAttempts[profile]++;
      connectionStatus[profile] = "reconnecting";
      console.log(`Reconnecting... (${reconnectAttempts[profile]}/${MAX_RECONNECT_ATTEMPTS})`, profile);

      if (reason === 428) {
        console.log("Rate limited (428), waiting longer before reconnect");
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
    connection: isConnected ? "open" : connectionStatus[profile] || "closed",
    phone: connectedPhones[profile] || null,
    hasQR: !!sock.lastQR,
    hasPairing: !!sock.lastPairingCode,
    qr: sock.lastQR ? true : false,
    pairing: sock.lastPairingCode || null,
    reconnectAttempts: reconnectAttempts[profile] || 0
  });
});

// -------------------------------------------
// SEND MESSAGE ENDPOINT (for order confirmations and other programmatic messages)
// -------------------------------------------
app.post("/send-message", async (req, res) => {
  try {
    const { profile, to, message } = req.body;

    if (!profile) {
      return res.status(200).json({ success: false, error: "profile required" });
    }
    if (!to) {
      return res.status(200).json({ success: false, error: "to (recipient) required" });
    }
    if (!message) {
      return res.status(200).json({ success: false, error: "message required" });
    }

    let sock = sessions[profile];

    // If there's no active session in memory, try to restore it from saved credentials
    if (!sock) {
      console.log("No active session for profile, attempting to restore:", profile);
      try {
        sock = await createClient(profile, false);
        
        // Wait a moment for connection to establish
        await new Promise(resolve => setTimeout(resolve, 3000));
      } catch (err) {
        console.error("Failed to restore session for profile", profile, err);
        return res.status(200).json({
          success: false,
          error: "session not found - please re-connect WhatsApp Web on the dashboard"
        });
      }
    }

    if (!sock) {
      return res.status(200).json({
        success: false,
        error: "session not found after restore - please re-connect WhatsApp Web"
      });
    }

    // Check if connected
    if (connectionStatus[profile] !== "open") {
      console.log("Session exists but is not connected:", profile, connectionStatus[profile]);
      return res.status(200).json({
        success: false,
        error: "session not connected - please open WhatsApp Web and wait for it to connect"
      });
    }

    // Normalize recipient to proper WhatsApp JID
    let jid = to;
    try {
      const [rawNumber] = String(to).split("@");
      const digits = String(rawNumber).replace(/\D/g, "");

      if (!digits) {
        console.error("Invalid recipient phone number:", to);
        return res.status(200).json({
          success: false,
          error: "invalid recipient phone number"
        });
      }

      jid = `${digits}@s.whatsapp.net`;
    } catch (normErr) {
      console.error("Error normalizing recipient number:", normErr);
      return res.status(200).json({
        success: false,
        error: "failed to normalize recipient number"
      });
    }

    console.log(`Sending message to ${jid} via profile ${profile}`);

    await sock.sendMessage(jid, { text: message });

    console.log(`Message sent successfully to ${jid}`);

    return res.status(200).json({
      success: true,
      message: "Message sent successfully",
      to,
      profile
    });
  } catch (e) {
    console.error("SEND MESSAGE ERROR:", e);
    return res.status(200).json({
      success: false,
      error: e.message || "Failed to send message"
    });
  }
});

// -------------------------------------------
// DISCONNECT ENDPOINT
// -------------------------------------------
app.post("/disconnect", async (req, res) => {
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

  // Also remove from database
  try {
    await fetch(`${SUPABASE_URL}/functions/v1/whatsapp-session-persist`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
      },
      body: JSON.stringify({ action: 'delete', profileId: profile })
    });
  } catch (err) {
    console.error("Error deleting session from database:", err);
  }

  return res.json({ success: true, message: "session disconnected" });
});

// -------------------------------------------
// DEBUG ENDPOINT
// -------------------------------------------
app.get("/debug", (req, res) => {
  res.json({
    sessions: Object.keys(sessions),
    phones: connectedPhones,
    connectionStatus: connectionStatus,
    reconnectAttempts: reconnectAttempts
  });
});

// -------------------------------------------
// HEALTH CHECK
// -------------------------------------------
app.get("/health", (req, res) => res.send("OK"));

// -------------------------------------------
// START SERVER AND RESTORE SESSIONS
// -------------------------------------------
app.listen(8080, "0.0.0.0", async () => {
  console.log("WhatsApp Service running on port 8080");
  
  // Restore sessions from database after server starts
  setTimeout(async () => {
    await restoreSessionsFromDatabase();
  }, 2000);
});
