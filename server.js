import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys'

import express from 'express'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const app = express()
const PORT = process.env.PORT || 8080

async function createWhatsAppClient(profileId) {
  console.log(`Starting connection for profile: ${profileId}`)

  const authDir = path.join(__dirname, 'auth', profileId)
  const { state, saveCreds } = await useMultiFileAuthState(authDir)

  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    printQRInTerminal: true,
    auth: state,
    syncFullHistory: false
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update

    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut

      if (shouldReconnect) {
        createWhatsAppClient(profileId)
      }
    }

    if (update.qr) {
      console.log("QR Code Received")
    }

    if (connection === 'open') {
      console.log("WhatsApp Connected Successfully")
    }
  })

  return sock
}

createWhatsAppClient("b71df34e-d0b3-4281-9a5c-4ad767d91c12")

app.listen(PORT, () => {
  console.log(`WhatsApp Railway Service running on port ${PORT}`)
})
