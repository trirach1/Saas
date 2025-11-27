import express from 'express';
import cors from 'cors';
import pkg from '@whiskeysockets/baileys';
const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = pkg;
import qrcode from 'qrcode';
import fs from 'fs';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Store active connections
const activeSockets = new Map();

// Create WhatsApp client
async function createWhatsAppClient(profileId, userId) {
  const authFolder = `./auth_${profileId}`;
  
  // Create auth folder if it doesn't exist
  if (!fs.existsSync(authFolder)) {
    fs.mkdirSync(authFolder, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
  });

  // Save credentials on update
  sock.ev.on('creds.update', saveCreds);

  return sock;
}

// Initialize connection
async function initConnection(profileId, userId, usePairing = false) {
  try {
    console.log(`Starting connection for profile: ${profileId}`);
    
    // Clean up existing socket
    if (activeSockets.has(profileId)) {
      const oldSock = activeSockets.get(profileId);
      oldSock?.end();
      activeSockets.delete(profileId);
    }

    const sock = await createWhatsAppClient(profileId, userId);
    activeSockets.set(profileId, sock);

    let qrCode = null;
    let pairingCode = null;
    let connectionStatus = 'pending';

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout'));
      }, 60000);

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          console.log('QR received for profile:', profileId);
          qrCode = await qrcode.toDataURL(qr);
        }

        if (connection === 'close') {
          const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
          console.log('Connection closed. Reconnect?', shouldReconnect);
          
          clearTimeout(timeout);
          if (!shouldReconnect) {
            activeSockets.delete(profileId);
            reject(new Error('Logged out'));
          }
        } else if (connection === 'open') {
          console.log('Connected successfully for profile:', profileId);
          connectionStatus = 'connected';
          
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

      // Generate pairing code if requested
      if (usePairing && sock.requestPairingCode) {
        sock.requestPairingCode('1234567890').then(code => {
          pairingCode = code;
          console.log('Pairing code:', code);
        }).catch(err => {
          console.error('Pairing code error:', err);
        });
      }

      // Initial response with QR or pairing code
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
    console.error('Init error:', error);
    throw error;
  }
}

// API Routes
app.post('/init', async (req, res) => {
  try {
    const { profileId, userId, usePairing } = req.body;

    if (!profileId || !userId) {
      return res.status(400).json({ 
        status: 'error',
        error: 'Missing required fields' 
      });
    }

    console.log(`Initializing connection for ${profileId}`);
    const result = await initConnection(profileId, userId, usePairing);

    res.json(result);
  } catch (error) {
    console.error('Init endpoint error:', error);
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
      sock.end();
      activeSockets.delete(profileId);
      
      // Clean up auth folder
      const authFolder = `./auth_${profileId}`;
      if (fs.existsSync(authFolder)) {
        fs.rmSync(authFolder, { recursive: true, force: true });
      }
    }

    res.json({ status: 'success' });
  } catch (error) {
    console.error('Disconnect error:', error);
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
    activeConnections: activeSockets.size 
  });
});

app.listen(PORT, () => {
  console.log(`WhatsApp Railway Service running on port ${PORT}`);
});



