import express from "express";import makeWASocket, { useMultiFileAuthState, DisconnectReason} from "@whiskeysockets/baileys";import fs from "fs-extra";import pino from "pino";const app = express();app.use(express.json());const clients = {};async function createWhatsAppClient(profile) { console.log("Starting connection for profile:", profile); const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${profile}`); const sock = makeWASocket({ logger: pino({ level: "silent" }), printQRInTerminal: false, auth: state, syncFullHistory: false }); sock.ev.on("creds.update", saveCreds); sock.ev.on("connection.update", (update) => { const { connection, lastDisconnect, qr } = update; if (qr) { console.log("QR GENERATED FOR", profile); clients[profile].qr = qr; } if (connection === "close") { const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut; if (shouldReconnect) { console.log("Reconnecting for profile:", profile); createWhatsAppClient(profile); } } if (connection === "open") { console.log("WA CONNECTED:", profile); clients[profile].connected = true; } }); return sock;}
app.post("/init", async (req, res) => { const profile = req.body.profile; if (!profile) { return res.status(400).json({ error: "profile is required" }); } if (!clients[profile]) { clients[profile] = { qr: null, connected: false }; createWhatsAppClient(profile); } res.json({ success: true, message: "Client initializing", profile });});

// QR
app.get("/qr", (req, res) => {
    const profile = req.query.profile

    if (!profile)
        return res.status(400).json({ error: "profile is required" })

    if (!sessions[profile])
        return res.status(404).json({ error: "not initialized" })

    const qr = sessions[profile].qr
    if (!qr)
        return res.json({ success: false, message: "QR not ready" })

    res.json({ success: true, qr })
})

// STATUS
app.get("/status", (req, res) => {
    const profile = req.query.profile

    if (!profile)
        return res.status(400).json({ error: "profile is required" })

    if (!sessions[profile])
        return res.status(404).json({ error: "not initialized" })

    res.json({
        success: true,
        qr_ready: !!sessions[profile].qr
    })
})
app.listen(8080, () => console.log("WhatsApp Railway Service running on port 8080"));
