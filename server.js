import express from "express";
import QRCode from "qrcode";
import { Boom } from "@hapi/boom";
import fs from "fs";
import path from "path";
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
const keepaliveIntervals = {};
const MAX_RECONNECT_ATTEMPTS = 15;
const RECONNECT_DELAY = 3000;
const KEEPALIVE_INTERVAL = 45000;
const HEALTH_CHECK_INTERVAL = 5 * 60 * 1000;

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://hrshudfqrjyrgppkiaas.supabase.co';

// ============= DATABASE SESSION PERSISTENCE =============

async function saveSessionToDatabase(profile) {
  const sessionPath = `./sessions/${profile}`;
  if (!fs.existsSync(sessionPath)) {
    console.log('[DB] No session folder to save:', profile);
    return false;
  }

  try {
    const sessionData = {};
    const files = fs.readdirSync(sessionPath);
    
    for (const file of files) {
      const filePath = path.join(sessionPath, file);
      const stat = fs.statSync(filePath);
      if (stat.isFile()) {
        const content = fs.readFileSync(filePath, 'utf8');
        sessionData[file] = content;
      }
    }

    if (Object.keys(sessionData).length === 0) {
      console.log('[DB] No session files to save:', profile);
      return false;
    }

    console.log(`[DB] Saving ${Object.keys(sessionData).length} session files for:`, profile);

    const response = await fetch(`${SUPABASE_URL}/functions/v1/whatsapp-session-persist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'save',
        profileId: profile,
        sessionData: sessionData,
        connectedPhone: connectedPhones[profile] || null
      })
    });

    if (response.ok) {
      console.log('[DB] ✓ Session saved successfully:', profile);
      return true;
    } else {
      console.error('[DB] Failed to save session:', await response.text());
      return false;
    }
  } catch (error) {
    console.error('[DB] Error saving session:', error.message);
    return false;
  }
}

async function restoreSessionFromDatabase(profile) {
  try {
    console.log('[DB] Attempting to restore session:', profile);

    const response = await fetch(`${SUPABASE_URL}/functions/v1/whatsapp-session-persist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'get',
        profileId: profile
      })
    });

    if (!response.ok) {
      console.log('[DB] No session found in database:', profile);
      return false;
    }

    const data = await response.json();
    
    if (!data.sessionData || typeof data.sessionData !== 'object') {
      console.log('[DB] No valid session data:', profile);
      return false;
    }

    const sessionPath = `./sessions/${profile}`;
    if (!fs.existsSync(sessionPath)) {
      fs.mkdirSync(sessionPath, { recursive: true });
    }

    let filesWritten = 0;
    for (const [fileName, content] of Object.entries(data.sessionData)) {
      if (typeof content === 'string' && content.trim()) {
        const filePath = path.join(sessionPath, fileName);
        fs.writeFileSync(filePath, content, 'utf8');
        filesWritten++;
      }
    }

    if (filesWritten > 0) {
      console.log(`[DB] ✓ Restored ${filesWritten} session files for:`, profile);
      if (data.connectedPhone) {
        connectedPhones[profile] = data.connectedPhone;
      }
      return true;
    }

    return false;
  } catch (error) {
    console.error('[DB] Error restoring session:', error.message);
    return false;
  }
}

async function getProfilesToRestore() {
  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/whatsapp-session-persist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'list' })
    });

    if (response.ok) {
      const data = await response.json();
      return data.profiles || [];
    }
    return [];
  } catch (error) {
    console.error('[DB] Error getting profiles list:', error.message);
    return [];
  }
}

async function markSessionDisconnected(profile) {
  try {
    await fetch(`${SUPABASE_URL}/functions/v1/whatsapp-session-persist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'delete',
        profileId: profile
      })
    });
    console.log('[DB] Session marked as disconnected:', profile);
  } catch (error) {
    console.error('[DB] Error marking session disconnected:', error.message);
  }
}

// ============= KEEPALIVE & HEALTH =============

function startKeepalive(profile) {
  stopKeepalive(profile);
  keepaliveIntervals[profile] = setInterval(async () => {
    const sock = sessions[profile];
    if (sock && connectionStatus[profile] === 'open') {
      try {
        await sock.sendPresenceUpdate('available');
        console.log(`[KA] ♥ keepalive sent: ${profile}`);
      } catch (e) {
        console.warn(`[KA] keepalive failed: ${profile}`, e.message);
      }
    }
  }, KEEPALIVE_INTERVAL);
  console.log(`[KA] Started keepalive for: ${profile}`);
}

function stopKeepalive(profile) {
  if (keepaliveIntervals[profile]) {
    clearInterval(keepaliveIntervals[profile]);
    delete keepaliveIntervals[profile];
    console.log(`[KA] Stopped keepalive for: ${profile}`);
  }
}

async function runHealthCheck() {
  console.log('[HEALTH] Running session health check...');
  const profiles = Object.keys(sessions);
  
  for (const profile of profiles) {
    const sock = sessions[profile];
    const status = connectionStatus[profile];
    
    if (status !== 'open' && sock) {
      console.log(`[HEALTH] Session ${profile} is ${status}, attempting reconnect...`);
      try {
        try { sock.end(); } catch (e) {}
        delete sessions[profile];
        reconnectAttempts[profile] = 0;
        await createClient(profile, false, true);
      } catch (e) {
        console.error(`[HEALTH] Reconnect failed for ${profile}:`, e.message);
      }
    }
  }
  
  try {
    const dbProfiles = await getProfilesToRestore();
    for (const profileId of dbProfiles) {
      if (!sessions[profileId]) {
        console.log(`[HEALTH] Found orphaned DB session, restoring: ${profileId}`);
        try {
          await createClient(profileId, false, true);
          await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (e) {
          console.error(`[HEALTH] Failed to restore orphaned session: ${profileId}`, e.message);
        }
      }
    }
  } catch (e) {
    console.error('[HEALTH] Error checking DB sessions:', e.message);
  }
  
  console.log('[HEALTH] Health check complete');
}

// ============= WHATSAPP CLIENT MANAGEMENT =============

async function createClient(profile, pairing = false, isRestore = false) {
  console.log(`[WA] Starting client: ${profile}, pairing: ${pairing}, restore: ${isRestore}`);

  const sessionPath = `./sessions/${profile}`;
  
  if (isRestore) {
    const restored = await restoreSessionFromDatabase(profile);
    if (!restored) {
      console.log('[WA] Could not restore session, marking as disconnected:', profile);
      await markSessionDisconnected(profile);
      return null;
    }
  }

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
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
  });

  sock.lastQR = null;
  sock.lastPairingCode = null;

  sock.ev.on("creds.update", async () => {
    await saveCreds();
    await saveSessionToDatabase(profile);
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    console.log("[WA] Messages received:", type, "count:", messages.length);
    
    for (const msg of messages) {
      if (msg.key.fromMe) continue;

      const messageText = msg.message?.conversation || 
                          msg.message?.extendedTextMessage?.text ||
                          msg.message?.imageMessage?.caption ||
                          msg.message?.videoMessage?.caption ||
                          null;
      
      if (!messageText) continue;

      const from = msg.key.remoteJid;
      console.log(`[WA] New message from ${from}: ${messageText.substring(0, 50)}...`);

      try {
        const response = await fetch(`${SUPABASE_URL}/functions/v1/whatsapp-web-message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profile, from, message: messageText, messageId: msg.key.id })
        });

        if (response.ok) {
          const data = await response.json();
          if (data.skipped) {
            console.log(`[WA] Message skipped (${data.reason}):`, from);
          } else if (data.reply) {
            try {
              await sock.sendMessage(from, { text: data.reply });
              console.log(`[WA] ✓ Sent reply to ${from}`);
            } catch (sendErr) {
              console.error('[WA] Send failed:', sendErr.message);
            }
          }
        } else {
          console.error('[WA] Edge function error:', response.status, await response.text());
        }
      } catch (error) {
        console.error('[WA] Error processing message:', error.message);
      }
    }
  });

  sock.ev.on("connection.update", async (update) => {
    const { qr, connection, lastDisconnect, pairingCode } = update;

    if (qr) {
      console.log("[WA] QR received:", profile);
      sock.lastQR = qr;
      reconnectAttempts[profile] = 0;
    }

    if (pairingCode) {
      console.log("[WA] PAIRING CODE:", pairingCode);
      sock.lastPairingCode = pairingCode;
      reconnectAttempts[profile] = 0;
    }

    if (connection === "open") {
      console.log("[WA] ✓ CONNECTED:", profile);
      reconnectAttempts[profile] = 0;
      connectionStatus[profile] = "open";
      
      startKeepalive(profile);
      
      try {
        const phoneNumber = sock.user?.id?.split(':')[0] || sock.user?.id;
        if (phoneNumber) {
          connectedPhones[profile] = phoneNumber;
          console.log("[WA] Phone number:", phoneNumber);
        }
        await saveSessionToDatabase(profile);
      } catch (e) {
        console.error('[WA] Error on connection open:', e.message);
      }
    }

    if (connection === "close") {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log("[WA] Disconnected:", profile, "reason:", reason);
      connectionStatus[profile] = "closed";

      if (reason === DisconnectReason.loggedOut || reason === 428) {
        console.log("[WA] Session logged out, clearing:", profile);
        stopKeepalive(profile);
        const sp = `./sessions/${profile}`;
        if (fs.existsSync(sp)) fs.rmSync(sp, { recursive: true, force: true });
        delete sessions[profile];
        delete reconnectAttempts[profile];
        delete connectedPhones[profile];
        delete connectionStatus[profile];
        await markSessionDisconnected(profile);
        return;
      }

      stopKeepalive(profile);
      if (!reconnectAttempts[profile]) reconnectAttempts[profile] = 0;
      
      if (reconnectAttempts[profile] >= MAX_RECONNECT_ATTEMPTS) {
        console.log("[WA] Max reconnect attempts reached, will retry via health check:", profile);
        return;
      }

      reconnectAttempts[profile]++;
      const delay = Math.min(RECONNECT_DELAY * Math.pow(1.5, reconnectAttempts[profile] - 1), 60000);
      console.log(`[WA] Reconnecting in ${Math.round(delay/1000)}s (attempt ${reconnectAttempts[profile]}/${MAX_RECONNECT_ATTEMPTS})`);
      
      setTimeout(() => createClient(profile, pairing, false), delay);
    }
  });

  sessions[profile] = sock;
  return sock;
}

// ============= STARTUP SESSION RESTORATION =============

async function restoreAllSessions() {
  console.log('[STARTUP] Starting session restoration...');
  
  const profiles = await getProfilesToRestore();
  console.log(`[STARTUP] Found ${profiles.length} sessions to restore`);

  for (const profileId of profiles) {
    try {
      console.log('[STARTUP] Restoring session:', profileId);
      await createClient(profileId, false, true);
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error) {
      console.error('[STARTUP] Failed to restore session:', profileId, error.message);
    }
  }

  console.log('[STARTUP] Session restoration complete');
}

// ============= EXPRESS ENDPOINTS =============

app.post("/init", async (req, res) => {
  try {
    const profile = req.body.profile || req.body.profileId;
    const pairing = req.body.pairing;
    const phoneNumber = req.body.phoneNumber;
    
    if (!profile) return res.status(400).json({ error: "profile required" });

    console.log('[API] Init request:', profile, 'pairing:', pairing);

    if (sessions[profile]) {
      try { sessions[profile].end(); } catch (e) {}
      delete sessions[profile];
    }
    reconnectAttempts[profile] = 0;

    const restored = await restoreSessionFromDatabase(profile);
    
    await createClient(profile, pairing === true, false);
    
    if (pairing && phoneNumber) {
      const sock = sessions[profile];
      if (sock) {
        const cleanPhone = String(phoneNumber).replace(/\D/g, '');
        try {
          const code = await sock.requestPairingCode(cleanPhone);
          return res.json({ 
            success: true, 
            message: "client initializing with pairing", 
            profile, 
            pairing_code: code,
            restored: restored 
          });
        } catch (e) {
          console.error('[API] Pairing code request failed:', e.message);
        }
      }
    }
    
    return res.json({ success: true, message: "client initializing", profile, restored });
  } catch (e) {
    console.error('[API] Init error:', e.message);
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
    console.error('[API] Pairing error:', e.message);
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
    
    if (!profile || !to || !message) {
      return res.json({ success: false, error: "missing params" });
    }

    let sock = sessions[profile];
    
    if (!sock) {
      console.log('[API] No session for send-message, attempting restore:', profile);
      const restored = await restoreSessionFromDatabase(profile);
      if (restored) {
        sock = await createClient(profile, false, false);
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
      
      if (!sock) {
        return res.json({ success: false, error: "session not found" });
      }
    }
    
    if (connectionStatus[profile] !== "open") {
      return res.json({ success: false, error: "not connected", status: connectionStatus[profile] });
    }

    const digits = String(to).replace(/\D/g, "");
    const jid = `${digits}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    return res.json({ success: true, to: jid });
  } catch (e) {
    console.error('[API] Send-message error:', e.message);
    return res.json({ success: false, error: e.message });
  }
});

app.post("/disconnect", async (req, res) => {
  const profile = req.body.profile || req.body.profileId;
  if (!profile) return res.status(400).json({ error: "profile required" });
  
  console.log('[API] Disconnect request:', profile);

  stopKeepalive(profile);
  const sock = sessions[profile];
  if (sock) {
    try { sock.end(); } catch (e) {}
    delete sessions[profile];
  }
  delete reconnectAttempts[profile];
  delete connectedPhones[profile];
  connectionStatus[profile] = "disconnected";
  
  await markSessionDisconnected(profile);
  
  const sp = `./sessions/${profile}`;
  if (fs.existsSync(sp)) fs.rmSync(sp, { recursive: true, force: true });
  
  delete connectionStatus[profile];
  return res.json({ success: true });
});

app.get("/debug", (req, res) => {
  res.json({ 
    sessions: Object.keys(sessions), 
    phones: connectedPhones, 
    status: connectionStatus,
    timestamp: new Date().toISOString()
  });
});

app.get("/health", (req, res) => res.send("OK"));

// ============= START SERVER =============

const PORT = process.env.PORT || 8080;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[SERVER] WhatsApp Service running on port ${PORT}`);
  console.log('[SERVER] Starting session restoration in 5 seconds...');
  
  setTimeout(restoreAllSessions, 5000);
  
  setInterval(runHealthCheck, HEALTH_CHECK_INTERVAL);
  console.log(`[SERVER] Health check scheduled every ${HEALTH_CHECK_INTERVAL / 60000} minutes`);
});
