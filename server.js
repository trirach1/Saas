import express from "express";
import makeWASocket, {
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  DisconnectReason
} from "@whiskeysockets/baileys";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

const sessions = {}; // store active sessions

// CREATE WA SESSION
async function createSession(profile) {
  console.log("Starting connection for profile:", profile);

  const sessionDir = path.join(__dirname, "sessions", profile);
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true, // show QR in logs
    syncFullHistory: false,
  });

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) console.log("QR GENERATED:", qr);

    if (connection === "open") {
      console.log("WhatsApp connected:", profile);
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;

      console.log("connection closed, reconnect:", shouldReconnect);

      if (shouldReconnect) createSession(profile);
      else console.log("Logged out, session removed");
    }
  });

  sessions[profile] = sock;
  return sock;
}

// API — INIT & GET QR
app.post("/init", async (req, res) => {
  try {
    const profile = req.body.profile;
    if (!profile) return res.status(400).json({ error: "profile is required" });

    const sock = await createSession(profile);

    return res.json({
      success: true,
      message: "QR generated in logs",
      profile,
    });
  } catch (e) {
    console.error("INIT ERROR:", e);
    res.status(500).json({ error: e.message });
  }
});

// API — SEND MESSAGE
app.post("/send", async (req, res) => {
  try {
    const { profile, number, message } = req.body;

    if (!sessions[profile])
      return res.status(400).json({ error: "Profile session not initialized" });

    const jid = number + "@s.whatsapp.net";
    await sessions[profile].sendMessage(jid, { text: message });

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get("/", (req, res) => {
  res.status(200).send("OK");
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "healthy" });
});
app.listen(8080, () => console.log("WhatsApp Railway Service running on port 8080"));
