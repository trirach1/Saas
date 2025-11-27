// server.js
import express from "express"
import cors from "cors"
import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } from "@whiskeysockets/baileys"
import fs from "fs"
import path from "path"

const app = express()
app.use(cors())
app.use(express.json())

const sessions = {}

const SESSIONS_FOLDER = "./sessions"
if (!fs.existsSync(SESSIONS_FOLDER)) fs.mkdirSync(SESSIONS_FOLDER)

/* ---------------- HEALTHCHECK (REQUIRED BY RAILWAY) ---------------- */
app.get("/health", (req, res) => {
    res.status(200).json({ status: "ok" })
})

async function createClient(profile) {
    const sessionPath = path.join(SESSIONS_FOLDER, profile)

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath)
    const { version } = await fetchLatestBaileysVersion()

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false
    })

    sock.ev.on("creds.update", saveCreds)

    sock.ev.on("connection.update", (update) => {
        const { connection, qr, lastDisconnect } = update

        if (qr) {
            sessions[profile].qr = qr
        }

        if (connection === "close") {
            const shouldReconnect =
                lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut

            if (shouldReconnect) createClient(profile)
        }
    })

    return sock
}

/* ---------------- ROUTES ------------------- */

// INIT
app.post("/init", async (req, res) => {
    const { profile } = req.body

    if (!profile)
        return res.status(400).json({ error: "profile is required" })

    if (sessions[profile])
        return res.json({ success: true, message: "Already initialized" })

    sessions[profile] = { qr: null }

    createClient(profile)

    return res.json({
        success: true,
        message: "Client initializing",
        profile
    })
})

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

// START SERVER
app.listen(8080, () => {
    console.log("WhatsApp Railway Service running on port 8080")
})
