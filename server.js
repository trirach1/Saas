// server.js
import express from "express"
import cors from "cors"
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} from "@whiskeysockets/baileys"

import fs from "fs"
import path from "path"

const app = express()
app.use(cors())
app.use(express.json())

/* ------------------------- GLOBAL SESSIONS ------------------------- */
const sessions = {}   // ← MUST BE HERE, before routes

/* ------------------------- SESSION FOLDER -------------------------- */
const SESSIONS_DIR = "./sessions"
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR)

/* ------------------------- HEALTHCHECK ----------------------------- */
app.get("/health", (req, res) => {
    res.status(200).json({ status: "ok" })
})

/* ------------------------- CREATE CLIENT --------------------------- */
async function createClient(profile) {
    const sessionPath = path.join(SESSIONS_DIR, profile)

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
            console.log("QR GENERATED for", profile)
            sessions[profile].qr = qr
        }

        if (connection === "close") {
            const shouldReconnect =
                lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut

            if (shouldReconnect) {
                console.log("Reconnecting:", profile)
                createClient(profile)
            }
        }
    })

    return sock
}

/* ------------------------- ROUTES ---------------------------------- */

// INIT CLIENT
app.post("/init", async (req, res) => {
    const { profile } = req.body

    if (!profile)
        return res.status(400).json({ error: "profile is required" })

    if (!sessions[profile])
        sessions[profile] = { qr: null }

    createClient(profile)

    return res.json({
        success: true,
        message: "Client initializing",
        profile
    })
})

// GET QR
app.get("/qr", async (req, res) => {
    const profile = req.query.profile

    if (!profile)
        return res.status(400).json({ error: "profile is required" })

    if (!sessions[profile])
        return res.status(404).json({ error: "profile not initialized" })

    const qr = sessions[profile].qr

    if (!qr)
        return res.json({ success: false, message: "QR not ready yet" })

    return res.json({ success: true, qr })
})

/* ------------------------- START SERVER ---------------------------- */
app.listen(8080, () => {
    console.log("WhatsApp Railway Service running on port 8080")
})
