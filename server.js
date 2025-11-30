import express from "express";
import makeWASocket, {
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";
import pino from "pino";
import cors from "cors";

const app = express();
app.use(express.json());
app.use(cors());

// ❤️ HEALTHCHECK FOR RAILWAY / DOCKER / LOAD BALANCERS
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

const sessions = {};

async function startClient(profile, phoneNumber) {
  const { state, saveCreds } = await useMultiFileAuthState(`./auth/${profile}`);
  const { version } = await fetchLatestBaileysVersion();

  console.log(`Starting client: ${profile}, pairing: true`);

  const sock = makeWASocket({
    version,
    printQRInTerminal: false,
    browser: ["TrirachAI", "Chrome", "1.0.0"],
    auth: state,
    logger: pino({ level: "silent" })
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection } = update;

    if (update.qr) {
      console.log("QR RECEIVED:", profile);
      sessions[profile].qr = update.qr;
    }

    if (connection === "open") {
      console.log("Connected to WhatsApp:", profile);

      if (!state.creds.registered && phoneNumber) {
        console.log("Requesting pairing code for:", phoneNumber);

        try {
          const code = await sock.requestPairingCode(phoneNumber);
          console.log("PAIRING CODE:", code);
          sessions[profile].pairing = code;
        } catch (err) {
          console.error("PAIRING ERROR:", err);
        }
      }
    }

    if (connection === "close") {
      console.log("Disconnected:", profile);
    }
  });

  sessions[profile] = { client: sock, qr: null, pairing: null };
}

app.post("/init", async (req, res) => {
  const { profile, phone } = req.body;

  if (!profile) return res.json({ error: "profile is required" });

  await startClient(profile, phone || null);

  return res.json({
    success: true,
    message: "client initializing",
    profile
  });
});

app.get("/qr", (req, res) => {
  const profile = req.query.profile;

  if (!sessions[profile]) return res.send("Client not initialized");
  if (sessions[profile].qr) return res.send(sessions[profile].qr);

  res.send("No QR available yet");
});

app.get("/pairing", (req, res) => {
  const profile = req.query.profile;

  if (!sessions[profile]) return res.send("Client not initialized");
  if (sessions[profile].pairing) return res.send(sessions[profile].pairing);

  res.send("Pairing code not ready");
});

app.listen(8080, () => {
  console.log("WhatsApp Service running on port 8080");
});
