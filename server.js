const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const express = require('express');
const qrcode = require('qrcode');
const fs = require('fs');
const pino = require('pino');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const activeSockets = new Map();

const logger = pino({ level: 'info' });

async function createWhatsAppClient(profileId, userId) {
  const authFolder = `./auth_${profileId}`;
  
  if (!fs.existsSync(authFolder)) {
    fs.mkdirSync(authFolder, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['AutomateAI', 'Chrome', '1.0.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  return sock;
}

async function initConnection(profileId, userId, usePairing = false) {
  try {
    logger.info(`Starting connection for profile: ${profileId}`);
    
    if (activeSockets.has(profileId)) {
      const oldSock = activeSockets.get(profileId);
      try {
        oldSock?.end();
      } catch (err) {
        logger.error('Error ending old socket:', err);
      }
      activeSockets.delete(profileId);
    }

    const sock = await createWhatsAppClient(profileId, userId);
    activeSockets.set(profileId, sock);

    let qrCode = null;
    let pairingCode = null;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout'));
      }, 60000);

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          logger.info('QR received for profile:', profileId);
          try {
            qrCode = await qrcode.toDataURL(qr);
          } catch (err) {
            logger.error('QR generation error:', err);
          }
        }

        if (connection === 'close') {
          const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
          logger.info('Connection closed. Reconnect?', shouldReconnect);
          
          clearTimeout(timeout);
          if (!shouldReconnect) {
            activeSockets.delete(profileId);
            reject(new Error('Logged out'));
          }
        } else if (connection === 'open') {
          logger.info('Connected successfully for profile:', profileId);
          
          const phoneNumber = sock.user?.id?.split(':')[0];
          clearTimeout(timeout);
          resolve({
            status: 'success',
            qrCode,
            pairingCode,
            phoneNumber: phoneNumber ? `+${phoneNumber}` : null,
          });
        }
      });

      if (usePairing && sock.requestPairingCode) {
        sock.requestPairingCode('1234567890').then(code => {
          pairingCode = code;
          logger.info('Pairing code generated');
        }).catch(err => {
          logger.error('Pairing code error:', err);
        });
      }

      setTimeout(() => {
        if (qrCode || pairingCode) {
          resolve({
            status: 'pending',
            qrCode,
            pairingCode,
          });
        }
      }, 3000);
    });
  } catch (error) {
    logger.error('Init error:', error);
    throw error;
  }
}

app.post('/init', async (req, res) => {
  try {
    const { profileId, userId, usePairing } = req.body;

    if (!profileId || !userId) {
      return res.status(400).json({ 
        status: 'error',
        error: 'Missing required fields' 
      });
    }

    logger.info(`Initializing connection for ${profileId}`);
    const result = await initConnection(profileId, userId, usePairing);

    res.json(result);
  } catch (error) {
    logger.error('Init endpoint error:', error);
    res.status(500).json({ 
      status: 'error',
      error: error.message 
    });
  }
});

app.post('/disconnect', async (req, res) => {
  try {
    const { profileId } = req.body;

    if (!profileId) {
      return res.status(400).json({ error: 'Missing profileId' });
    }

    const sock = activeSockets.get(profileId);
    if (sock) {
      try {
        sock.end();
      } catch (err) {
        logger.error('Error ending socket:', err);
      }
      activeSockets.delete(profileId);
      
      const authFolder = `./auth_${profileId}`;
      if (fs.existsSync(authFolder)) {
        try {
          fs.rmSync(authFolder, { recursive: true, force: true });
        } catch (err) {
          logger.error('Error removing auth folder:', err);
        }
      }
    }

    res.json({ status: 'success' });
  } catch (error) {
    logger.error('Disconnect error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/status/:profileId', (req, res) => {
  const { profileId } = req.params;
  const sock = activeSockets.get(profileId);
  
  res.json({
    connected: sock ? true : false,
    status: sock ? 'connected' : 'disconnected'
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    activeConnections: activeSockets.size,
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`WhatsApp Railway Service running on port ${PORT}`);
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  activeSockets.forEach((sock, profileId) => {
    try {
      sock.end();
    } catch (err) {
      logger.error(`Error closing socket for ${profileId}:`, err);
    }
  });
  process.exit(0);
});
