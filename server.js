
// server.js
import express from "express"
import cors from "cors"
import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } from "@whiskeysockets/baileys"
import fs from "fs"
import path from "path"

const app = express()
app.use(cors())
app.use(express.json())

const sessions = {}   // save open connections

// Create folder for session files
const SESSIONS_FOLDER = "./sessions"
if (!fs.existsSync(SESSIONS_FOLDER)) fs.mkdirSync(SESSIONS_FOLDER)

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
            if (lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut) {
                createClient(profile)
            }
        }
    })

    return sock
}

/* ---------------- ROUTES ------------------- */

// 1️⃣ INIT CONNECTION
app.post("/init", async (req, res) => {
    const { profile } = req.body

    if (!profile) {
        return res.status(400).json({ error: "profile is required" })
    }

    if (sessions[profile]) {
        return res.json({ success: true, message: "Already initialized" })
    }

    sessions[profile] = { qr: null }

    createClient(profile)

    return res.json({
        success: true,
        message: "Client initializing",
        profile
    })
})

// 2️⃣ GET QR
app.get("/qr", async (req, res) => {
    const profile = req.query.profile

    if (!profile) return res.status(400).json({ error: "profile is required" })
    if (!sessions[profile]) return res.status(404).json({ error: "not initialized" })

    if (!sessions[profile].qr) {
        return res.json({ success: false, message: "QR not ready" })
    }

    return res.json({
        success: true,
        qr: sessions[profile].qr
    })
})

// 3️⃣ CHECK STATUS
app.get("/status", async (req, res) => {
    const profile = req.query.profile

    if (!profile) return res.status(400).json({ error: "profile is required" })
    if (!sessions[profile]) return res.status(404).json({ error: "not initialized" })

    return res.json({
        success: true,
        qr_ready: !!sessions[profile].qr
    })
})

/* ---------------- START SERVER ------------------- */
app.listen(8080, () => {
    console.log("WhatsApp Railway Service running on port 8080")
})

