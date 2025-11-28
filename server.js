import express from "express";
import QRCode from "qrcode";
import { Boom } from "@hapi/boom";
import {
  makeWASocket,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  DisconnectReason
} from "@whiskeysockets/baileys";

const app = express();
app.use(express.json());

// IMPORTANT: SESSION STORE
const sessions = {}; // <-- THIS WAS MISSING !!!

// ---------------- INIT ------------------

app.post("/init", async (req, res) => {
  try {
    const { profile, pairing } = req.body;

    if (!profile) return res.status(400).json({ error: "profile required" });

    console.log("Initializing WhatsApp for:", profile);

    const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${profile}`);

    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      syncFullHistory: false,
      browser: ["Railway", "Chrome", "1.0"],
    });

    sock.lastQR = null;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { qr, connection, lastDisconnect } = update;

      if (qr) {
        console.log("QR RECEIVED for", profile);
        sock.lastQR = qr;
      }

      if (connection === "close") {
        const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;

        console.log("Disconnected:", reason);

        if (reason !== DisconnectReason.loggedOut) {
          createWhatsAppClient(profile);
        }
      }

      if (connection === "open") {
        console.log("CONNECTED:", profile);
      }
    });

    sessions[profile] = sock;

    return res.json({
      success: true,
      message: "client initializing",
      profile,
    });

  } catch (e) {
    console.error("INIT ERROR:", e);
    return res.status(500).json({ error: e.message });
  }
});

// ---------------- QR endpoint ------------------

app.get("/qr", async (req, res) => {
  const profile = req.query.profile;

  if (!profile) return res.status(400).send("profile required");

  const sock = sessions[profile];

  if (!sock) return res.status(404).send("session not initialized");

  if (sock.lastQR) {
    const svg = await QRCode.toString(sock.lastQR, { type: "svg" });
    res.setHeader("Content-Type", "image/svg+xml");
    return res.send(svg);
  }

  // WAIT FOR QR
  let sent = false;
  const listener = async (update) => {
    if (update.qr && !sent) {
      sent = true;
      sock.ev.off("connection.update", listener);
      const svg = await QRCode.toString(update.qr, { type: "svg" });
      res.setHeader("Content-Type", "image/svg+xml");
      res.send(svg);
    }
  };

  sock.ev.on("connection.update", listener);

  setTimeout(() => {
    if (!sent) {
      sock.ev.off("connection.update", listener);
      res.status(408).send("QR timeout");
    }
  }, 10000);
});

// ---------------- DEBUG ------------------

app.get("/debug", (req, res) => {
  res.json({
    sessions: Object.keys(sessions),
    hasQR: sessions["test-profile"]?.lastQR ? true : false,
    status: sessions["test-profile"]?.ws?.readyState || "no ws",
  });
});

// ---------------- HEALTH ------------------

app.get("/health", (req, res) => res.send("OK"));

app.listen(8080, () => console.log("WhatsApp Service running on port 8080"));
