const express = require('express');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const P = require('pino');

const app = express();
app.use(express.json());

const logger = P({ level: 'info' });
const sessions = new Map();

async function startSession(profileId, userId) {
  try {
    const sessionPath = `./sessions/${profileId}`;
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    const sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      logger,
      printQRInTerminal: false
    });

    let qrCode = null;
    let pairingCode = null;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrCode = await QRCode.toDataURL(qr);
        logger.info({ profileId }, 'QR Code generated');
      }

      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        logger.info({ profileId, shouldReconnect }, 'Connection closed');
        
        if (shouldReconnect) {
          setTimeout(() => startSession(profileId, userId), 3000);
        } else {
          sessions.delete(profileId);
        }
      }

      if (connection === 'open') {
        logger.info({ profileId }, 'Connection opened');
        // TODO: Notify Supabase that connection is established
      }
    });

    sessions.set(profileId, { sock, qrCode, pairingCode });
    return { sock, qrCode, pairingCode };
  } catch (error) {
    logger.error({ profileId, error: error.message }, 'Failed to start session');
    throw error;
  }
}

// Initialize connection
app.post("/init", async (req, res) => {
  try {
    const { profile_id } = req.body;

    if (!profile_id) {
      return res.status(400).json({ success: false, error: "Missing profile_id" });
    }

    console.log("Initialize WhatsApp session for:", profile_id);

    const result = await createWhatsAppClient(profile_id);
    res.json({ success: true, message: "Session initialized", result });
  } catch (err) {
    console.error("Init error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// Get connection status
app.get('/api/status/:profileId', (req, res) => {
  const { profileId } = req.params;
  const session = sessions.get(profileId);

  if (!session) {
    return res.json({ connected: false });
  }

  const connected = session.sock?.user !== undefined;
  res.json({
    connected,
    phone: session.sock?.user?.id || null
  });
});

// Disconnect session
app.post('/api/disconnect', async (req, res) => {
  try {
    const { profileId } = req.body;
    const session = sessions.get(profileId);

    if (session?.sock) {
      await session.sock.logout();
      sessions.delete(profileId);
    }

    res.json({ success: true });
  } catch (error) {
    logger.error({ error: error.message }, 'Disconnect failed');
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', sessions: sessions.size });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info({ port: PORT }, 'WhatsApp Baileys service started');
});
