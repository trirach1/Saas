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

// ... createWhatsAppClient + initConnection code ...

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
    connected: !!sock,
    status: sock ? 'connected' : 'disconnected',
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    activeConnections: activeSockets.size,
  });
});

app.listen(PORT, () => {
  console.log(`WhatsApp Railway Service running on port ${PORT}`);
});
