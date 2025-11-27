import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import {
  default as makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} from "@whiskeysockets/baileys";

const app = express();
app.use(cors());
app.use(express.json());

const clients = new Map();

async function createWhatsAppClient(profileId, webhookUrl) {
  const sessionPath = `./sessions/${profileId}`;
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("QR GENERATED for:", profileId);

      webhookUrl &&
        (await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event: "qr",
            profileId,
            qr,
          }),
        }));
    }

    if (connection === "open") {
      console.log("Connected:", profileId);

      webhookUrl &&
        (await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event: "connected",
            profileId,
          }),
        }));
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !==
        DisconnectReason.loggedOut;

      console.log("Connection closed:", profileId, "Reconnect:", shouldReconnect);

      if (shouldReconnect) createWhatsAppClient(profileId, webhookUrl);
    }
  });

  return sock;
}

// INIT
app.post("/init", async (req, res) => {
  const { profileId, webhookUrl } = req.body;

  if (!profileId)
    return res.status(400).json({ success: false, error: "profileId required" });

  if (clients.has(profileId))
    return res.json({
      success: true,
      message: "Already initialized",
    });

  const client = await createWhatsAppClient(profileId, webhookUrl);
  clients.set(profileId, client);

  res.json({ success: true, message: "Client initialized" });
});

// STATUS
app.get("/status/:profileId", (req, res) => {
  const client = clients.get(req.params.profileId);
  res.json({
    profileId: req.params.profileId,
    active: !!client,
  });
});

// HEALTH
app.get("/health", (req, res) => {
  res.json({ status: "healthy", activeClients: clients.size });
});

app.listen(3000, () => console.log("WhatsApp Railway Service running on port 3000"));
