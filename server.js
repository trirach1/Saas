import express from "express";
import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} from "@whiskeysockets/baileys";

import fs from "fs";
import path from "path";

const app = express();
app.use(express.json());

const SESSIONS_DIR = "./sessions";
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR);

// ----------------------------
// HEALTHCHECK ENDPOINT
// ----------------------------
app.get("/", (req, res) => {
  res.status(200).send("OK");
});

// ----------------------------
// CREATE CLIENT
// ----------------------------
async function createWhatsAppClient(profile, pairing = false) {
  const sessionPath = path.join(SESSIONS_DIR, profile);
  if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath);

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  console.log("Starting WA for profile:", profile);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ["Railway", "Chrome", "1.0"],
    syncFullHistory: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("QR GENERATED:", qr);
    }

    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log("Connection closed:", reason);

      if (reason !== DisconnectReason.loggedOut) {
        createWhatsAppClient(profile);
      }
    }

    if (connection === "open") {
      console.log("CONNECTED:", profile);
    }
  });

  return sock;
}

// ----------------------------
// INIT ENDPOINT
// ----------------------------
app.post("/init", async (req, res) => {
  try {
    const { profile, pairing = false } = req.body;

    if (!profile) return res.status(400).json({ error: "profile is required" });

    console.log("INIT:", profile);

    await createWhatsAppClient(profile, pairing);

    res.json({ success: true, profile });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------
// START SERVER
// ----------------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("WhatsApp Railway Service running on port", PORT);
});
