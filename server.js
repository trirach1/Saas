import express from "express";
import cors from "cors";
import fs from "fs";

// Import Baileys in a SAFE WAY for all versions
import * as baileys from "@whiskeysockets/baileys";

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = baileys;

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;

// Ensure sessions folder
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

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("QR CODE READY");
      console.log(qr);
    }

    if (connection === "open") {
      console.log("Connected:", profileId);
    }

    if (connection === "close") {
      const reason =
        lastDisconnect?.error?.output?.statusCode ||
        DisconnectReason.connectionClosed;

      console.log("Connection closed:", reason);

      if (reason !== DisconnectReason.loggedOut) {
        console.log("Reconnecting...");
        createWhatsAppClient(profileId);
      }
    }
  });

  clients[profileId] = sock;
  return sock;
}

// API
app.post("/init", async (req, res) => {
  const { profileId } = req.body;

  if (!profileId)
    return res.status(400).json({ success: false, error: "profileId missing" });

  if (!clients[profileId]) await createWhatsAppClient(profileId);

  res.json({ success: true });
});

app.get("/health", (req, res) => res.send("OK"));

app.listen(PORT, () => console.log("WhatsApp Railway Service running on port " + PORT));
