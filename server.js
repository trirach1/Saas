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
    const { connection, lastDisconnect } = update;

    if (update.qr) {
      console.log("QR RECEIVED:", profile);
      sessions[profile].qr = update.qr;
    }

    if (connection === "open") {
      console.log("Connected to WhatsApp:", profile);

      // REQUEST PAIRING CODE — ONLY IF NO SESSION EXISTS
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

// --------------------------- API ROUTES ---------------------------

// INIT CLIENT
app.post("/init", async (req, res) => {
  const { profile, pairing, phone } = req.body;

  if (!profile) return res.json({ error: "profile is required" });

  await startClient(profile, phone || null);

  return res.json({
    success: true,
    message: "client initializing",
    profile
  });
});

// GET QR CODE
app.get("/qr", (req, res) => {
  const profile = req.query.profile;

  if (!sessions[profile]) return res.send("Client not initialized");
  if (sessions[profile].qr) return res.send(sessions[profile].qr);

  res.send("No QR available yet");
});

// GET PAIRING CODE
app.get("/pairing", (req, res) => {
  const profile = req.query.profile;

  if (!sessions[profile]) return res.send("Client not initialized");
  if (sessions[profile].pairing) return res.send(sessions[profile].pairing);

  res.send("Pairing code not ready");
});


// ==================================================
// HEALTHCHECK FOR RAILWAY
// ==================================================
app.get("/health", (req, res) => res.send("OK"));


// ==================================================
// START SERVER
// ==================================================
const PORT = process.env.PORT || 8080;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`WhatsApp Service running on port ${PORT}`);
});
