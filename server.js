import express from "express";
import cors from "cors";
import fs from "fs";

import {
  default as makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} from "@whiskeysockets/baileys";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;

// Ensure sessions/ directory exists
if (!fs.existsSync("./sessions")) {
  fs.mkdirSync("./sessions");
}

const clients = {};

async function createWhatsAppClient(profileId) {
  console.log("Starting connection for profile:", profileId);

  const { state, saveCreds } = await useMultiFileAuthState(
    `./sessions/${profileId}`
  );

  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true
  });

  // MUST HAVE THIS OR DISCONNECTS
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) console.log("QR:", qr);

    if (connection === "close") {
      const reason =
        lastDisconnect?.error?.output?.statusCode || DisconnectReason.connectionClosed;

      console.log("Connection closed:", reason);

      if (reason !== DisconnectReason.loggedOut) {
        console.log("Reconnecting...");
        createWhatsAppClient(profileId);
      }
    }

    if (connection === "open") {
      console.log("Connected:", profileId);
    }
  });

  clients[profileId] = sock;
  return sock;
}

// -------- API ENDPOINTS ---------- //

app.post("/init", async (req, res) => {
  const { profileId } = req.body;

  if (!profileId)
    return res.status(400).json({ success: false, message: "profileId missing" });

  if (!clients[profileId]) await createWhatsAppClient(profileId);

  res.json({ success: true, message: "Client started" });
});

app.get("/status/:profileId", (req, res) => {
  res.json({ connected: !!clients[req.params.profileId] });
});

app.get("/health", (req, res) => res.send("OK"));

app.listen(PORT, () => {
  console.log("WhatsApp Railway Service running on port " + PORT);
});
