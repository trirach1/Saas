import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} from "@whiskeysockets/baileys"

import express from "express"
import cors from "cors"
import fs from "fs"

const app = express()
app.use(express.json())
app.use(cors())

let globalSock = null

async function createWhatsAppClient() {
  const authFolder = "./sessions"
  if (!fs.existsSync(authFolder)) fs.mkdirSync(authFolder)

  const { state, saveCreds } = await useMultiFileAuthState(authFolder)
  const { version } = await fetchLatestBaileysVersion()

  console.log("Starting Baileys client...")

  const sock = makeWASocket({
    version,
    printQRInTerminal: true,
    auth: state
  })

  sock.ev.on("creds.update", saveCreds)

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      console.log("QR RECEIVED")
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut

      console.log("Connection closed. Reconnect:", shouldReconnect)

      if (shouldReconnect) createWhatsAppClient()
      else console.log("Logged out. Delete /sessions folder to reset.")
    }

    if (connection === "open") {
      console.log("WhatsApp Connected Successfully!")
    }
  })

  return sock
}

// Start client
globalSock = await createWhatsAppClient()

// API — health check
app.get("/", (req, res) => {
  res.send({ status: "ok", message: "WhatsApp Railway Service Running" })
})

// API — send message
app.post("/send", async (req, res) => {
  try {
    const { number, message } = req.body

    if (!number || !message)
      return res.status(400).json({ error: "number & message required" })

    await globalSock.sendMessage(number + "@s.whatsapp.net", { text: message })
    res.json({ success: true })
  } catch (err) {
    console.log("Send error:", err)
    res.status(500).json({ success: false, error: err + "" })
  }
})

app.listen(3000, () =>
  console.log("WhatsApp Railway Service running on port 3000")
)
