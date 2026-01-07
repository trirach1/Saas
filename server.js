import makeWASocket, { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import express from 'express';
import cors from 'cors';
import pino from 'pino';
import NodeCache from 'node-cache';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const logger = pino({ level: 'silent' });
const msgRetryCounterCache = new NodeCache();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const PORT = process.env.PORT || 3000;

const connections = new Map();

async function callEdgeFunction(action, data) {
  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/whatsapp-session-persist`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'apikey': SUPABASE_ANON_KEY
      },
      body: JSON.stringify({ action, ...data })
    });
    return await response.json();
  } catch (error) {
    console.error(`Edge function error (${action}):`, error.message);
    return { success: false, error: error.message };
  }
}

async function saveSessionToDb(profileId, sessionData, connectedPhone) {
  console.log(`Saving session for profile: ${profileId}`);
  return await callEdgeFunction('save', { profileId, sessionData, connectedPhone });
}

async function getSessionFromDb(profileId) {
  console.log(`Loading session for profile: ${profileId}`);
  const result = await callEdgeFunction('get', { profileId });
  if (result.success && result.sessionData) {
    return result.sessionData;
  }
  return null;
}

async function deleteSessionFromDb(profileId) {
  console.log(`Deleting session for profile: ${profileId}`);
  return await callEdgeFunction('delete', { profileId });
}

async function initializeWhatsApp(profileId) {
  const authDir = path.join(__dirname, 'auth_sessions', profileId);
  
  const savedSession = await getSessionFromDb(profileId);
  if (savedSession) {
    try {
      if (!fs.existsSync(authDir)) {
        fs.mkdirSync(authDir, { recursive: true });
      }
      if (savedSession.creds) {
        fs.writeFileSync(path.join(authDir, 'creds.json'), JSON.stringify(savedSession.creds));
      }
      if (savedSession.keys) {
        for (const [filename, content] of Object.entries(savedSession.keys)) {
          fs.writeFileSync(path.join(authDir, filename), JSON.stringify(content));
        }
      }
      console.log(`Session restored from database for ${profileId}`);
    } catch (err) {
      console.error('Error restoring session:', err);
    }
  }

  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    msgRetryCounterCache,
    generateHighQualityLinkPreview: true,
    syncFullHistory: false,
    markOnlineOnConnect: false
  });

  const connectionData = {
    socket: sock,
    qrCode: null,
    pairingCode: null,
    status: 'connecting',
    connectedPhone: null,
    profileId
  };

  connections.set(profileId, connectionData);

  sock.ev.on('creds.update', async () => {
    await saveCreds();
    try {
      const credsPath = path.join(authDir, 'creds.json');
      if (fs.existsSync(credsPath)) {
        const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
        const keys = {};
        const files = fs.readdirSync(authDir).filter(f => f !== 'creds.json');
        for (const file of files) {
          try {
            keys[file] = JSON.parse(fs.readFileSync(path.join(authDir, file), 'utf-8'));
          } catch (e) {}
        }
        await saveSessionToDb(profileId, { creds, keys }, connectionData.connectedPhone);
      }
    } catch (err) {
      console.error('Error saving session to database:', err);
    }
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    const conn = connections.get(profileId);

    if (qr && conn) {
      conn.qrCode = qr;
      conn.status = 'waiting_for_qr';
      
      if (!conn.pairingCode && sock.authState?.creds?.me?.id === undefined) {
        try {
          const phoneNumber = conn.requestedPhone?.replace(/[^0-9]/g, '');
          if (phoneNumber && phoneNumber.length >= 10) {
            const code = await sock.requestPairingCode(phoneNumber);
            conn.pairingCode = code;
            console.log(`Pairing code for ${profileId}: ${code}`);
          }
        } catch (err) {
          console.log('Pairing code generation skipped:', err.message);
        }
      }
    }

    if (connection === 'open' && conn) {
      conn.status = 'connected';
      conn.qrCode = null;
      conn.pairingCode = null;
      conn.connectedPhone = sock.user?.id?.split(':')[0] || sock.user?.id;
      console.log(`WhatsApp connected for ${profileId}: ${conn.connectedPhone}`);
      notifyWebhook(profileId, 'connected', { phone: conn.connectedPhone });
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log(`Connection closed for ${profileId}: ${statusCode}`);

      if (statusCode === DisconnectReason.loggedOut) {
        await deleteSessionFromDb(profileId);
        if (fs.existsSync(authDir)) {
          fs.rmSync(authDir, { recursive: true, force: true });
        }
        connections.delete(profileId);
        notifyWebhook(profileId, 'disconnected', { reason: 'logged_out' });
      } else if (statusCode !== DisconnectReason.connectionClosed) {
        console.log(`Reconnecting ${profileId} in 3 seconds...`);
        setTimeout(() => initializeWhatsApp(profileId), 3000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      const from = msg.key.remoteJid;
      const text = msg.message?.conversation || 
                   msg.message?.extendedTextMessage?.text || 
                   msg.message?.imageMessage?.caption || '';
      if (text) {
        console.log(`Message from ${from}: ${text}`);
        await processIncomingMessage(profileId, from, text, msg);
      }
    }
  });

  return connectionData;
}

async function notifyWebhook(profileId, event, data) {
  try {
    await fetch(`${SUPABASE_URL}/functions/v1/whatsapp-web-webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'apikey': SUPABASE_ANON_KEY
      },
      body: JSON.stringify({ profileId, event, data })
    });
  } catch (err) {
    console.error('Webhook notification failed:', err.message);
  }
}

async function processIncomingMessage(profileId, from, text, rawMessage) {
  try {
    await fetch(`${SUPABASE_URL}/functions/v1/whatsapp-web-message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'apikey': SUPABASE_ANON_KEY
      },
      body: JSON.stringify({ profileId, from, text, messageId: rawMessage.key.id })
    });
  } catch (err) {
    console.error('Message processing failed:', err.message);
  }
}

app.post('/init', async (req, res) => {
  const { profileId, phoneNumber } = req.body;
  if (!profileId) return res.status(400).json({ error: 'profileId required' });

  let conn = connections.get(profileId);
  if (conn && conn.status === 'connected') {
    return res.json({ success: true, status: 'already_connected', phone: conn.connectedPhone });
  }

  conn = await initializeWhatsApp(profileId);
  if (phoneNumber) conn.requestedPhone = phoneNumber;
  res.json({ success: true, status: 'initializing' });
});

app.get('/status', (req, res) => {
  const { profileId } = req.query;
  if (!profileId) return res.status(400).json({ error: 'profileId required' });

  const conn = connections.get(profileId);
  if (!conn) return res.json({ status: 'not_initialized' });

  res.json({
    status: conn.status,
    qrCode: conn.qrCode,
    pairingCode: conn.pairingCode,
    connectedPhone: conn.connectedPhone
  });
});

app.post('/send', async (req, res) => {
  const { profileId, to, message } = req.body;
  if (!profileId || !to || !message) return res.status(400).json({ error: 'profileId, to, and message required' });

  const conn = connections.get(profileId);
  if (!conn || conn.status !== 'connected') return res.status(400).json({ error: 'Not connected' });

  try {
    const jid = to.includes('@') ? to : `${to.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    await conn.socket.sendMessage(jid, { text: message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/disconnect', async (req, res) => {
  const { profileId } = req.body;
  if (!profileId) return res.status(400).json({ error: 'profileId required' });

  const conn = connections.get(profileId);
  if (conn) {
    try { await conn.socket.logout(); } catch (err) {}
    connections.delete(profileId);
    await deleteSessionFromDb(profileId);
  }
  res.json({ success: true });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', connections: connections.size });
});

async function restoreActiveSessions() {
  console.log('Restoring active sessions...');
  const result = await callEdgeFunction('list', {});
  if (result.success && result.profileIds) {
    for (const profileId of result.profileIds) {
      console.log(`Restoring session: ${profileId}`);
      await initializeWhatsApp(profileId);
      await new Promise(r => setTimeout(r, 2000));
    }
    console.log(`Restored ${result.profileIds.length} sessions`);
  }
}

app.listen(PORT, () => {
  console.log(`WhatsApp Web Service running on port ${PORT}`);
  restoreActiveSessions();
});
