import express from "express";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason
} from "@whiskeysockets/baileys";
import fs from "fs-extra";
import pino from "pino";

const app = express();
app.use(express.json());

const clients = {};

async function createWhatsAppClient(profile) {
  console.log("Starting connection for profile:", profile);

  const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${profile}`);

  const sock = makeWASocket({
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    auth: state,
    syncFullHistory: false
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("QR GENERATED FOR", profile);
      clients[profile].qr = qr;
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

      if (shouldReconnect) {
        console.log("Reconnecting for profile:", profile);
        createWhatsAppClient(profile);
      }
    }

    if (connection === "open") {
      console.log("WA CONNECTED:", profile);
      clients[profile].connected = true;
    }
  });

  return sock;
}

app.post("/init", async (req, res) => {
  const profile = req.body.profile;

  if (!profile) {
    return res.status(400).json({ error: "profile is required" });
  }

  if (!clients[profile]) {
    clients[profile] = { qr: null, connected: false };
    createWhatsAppClient(profile);
  }

  res.json({ success: true, message: "Client initializing", profile });
});

app.get("/qr/:profile", (req, res) => {
  const profile = req.params.profile;

  if (!clients[profile] || !clients[profile].qr) {
    return res.json({ qr: null });
  }

  res.json({ qr: clients[profile].qr });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.listen(8080, () => console.log("WhatsApp Railway Service running on port 8080"));
