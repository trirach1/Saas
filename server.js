import express from "express";
import cors from "cors";
import fs from "fs";
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} from "@whiskeysockets/baileys";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ensure sessions folder exists
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
    printQRInTerminal: true,
    emitOwnEvents: true,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("QR for", profileId, ":", qr);
    }

    if (connection === "close") {
      const reason =
        lastDisconnect?.error?.output?.statusCode || "Unknown error";

      console.log("Connection closed. Reconnect?", reason !== 401);

      if (reason !== 401) {
        createWhatsAppClient(profileId);
      }
    }

    if (connection === "open") {
      console.log("Profile connected:", profileId);
    }
  });

  clients[profileId] = sock;
  return sock;
}

// -------- API ROUTES ---------- //

app.post("/init", async (req, res) => {
  const { profileId } = req.body;

  if (!profileId)
    return res.status(400).json({ success: false, msg: "profileId missing" });

  if (!clients[profileId]) await createWhatsAppClient(profileId);

  res.json({ success: true, message: "Client initialized" });
});

app.get("/status/:profileId", (req, res) => {
  const { profileId } = req.params;
  res.json({ connected: !!clients[profileId] });
});

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

app.listen(PORT, () => {
  console.log("WhatsApp Railway Service running on port " + PORT);
});

