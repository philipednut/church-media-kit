import express from "express";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason
} from "@whiskeysockets/baileys";
import pino from "pino";
import fs from "node:fs";

const app = express();
app.use(express.json({ limit: "50kb" }));

const PORT = Number(process.env.PORT || 3000);
const AUTH_DIR = process.env.AUTH_DIR || "./auth_info_baileys";
const PAIRING_PHONE = process.env.PAIRING_PHONE || "2348104632231";
const GROUP_JIDS = (process.env.WHATSAPP_GROUP_JIDS || "")
  .split(",")
  .map(id => id.trim())
  .filter(id => id.endsWith("@g.us"));

let sock;
let isConnected = false;
let isSending = false;
let reconnectTimer;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function connectWhatsApp() {
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: "warn" }),
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
    if (connection === "open") {
      isConnected = true;
      console.log("WhatsApp connected.");
    }

    if (connection === "close") {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;

      if (statusCode === DisconnectReason.loggedOut) {
        console.error("WhatsApp logged out. Manual relinking is required.");
        return;
      }

      console.log("WhatsApp disconnected. Reconnecting...");
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        connectWhatsApp().catch(console.error);
      }, 5000);
    }
  });

  if (!state.creds.registered && PAIRING_PHONE) {
    await sleep(3000);
    try {
      const code = await sock.requestPairingCode(PAIRING_PHONE);
      console.log("WhatsApp pairing code:", code);
      console.log("Enter it in WhatsApp > Linked devices.");
    } catch (error) {
      console.error("Could not create pairing code:", error.message);
    }
  }
}

app.get("/", (req, res) => {
  res.json({ service: "Church WhatsApp Sender", connected: isConnected });
});

app.get("/groups", async (req, res) => {
  if (!isConnected || !sock) {
    return res.status(503).json({ success: false, error: "WhatsApp is not connected." });
  }

  try {
    const groups = await sock.groupFetchAllParticipating();
    res.json({
      success: true,
      groups: Object.entries(groups).map(([jid, group]) => ({
        name: group.subject,
        jid
      }))
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/send-announcement", async (req, res) => {
  const message = req.body?.message;

  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ success: false, error: "Announcement message is empty." });
  }

  if (message.length > 10000) {
    return res.status(400).json({ success: false, error: "Announcement is too long." });
  }

  if (!isConnected || !sock) {
    return res.status(503).json({ success: false, error: "WhatsApp is not connected." });
  }

  if (GROUP_JIDS.length < 5) {
    return res.status(400).json({ success: false, error: "Configure at least five group JIDs first." });
  }

  if (isSending) {
    return res.status(409).json({ success: false, error: "Another sending operation is in progress." });
  }

  isSending = true;
  const sent = [];
  const failed = [];

  try {
    for (const groupJid of GROUP_JIDS) {
      try {
        await sock.sendMessage(groupJid, { text: message.trim() });
        sent.push(groupJid);
        console.log("Announcement sent to:", groupJid);
      } catch (error) {
        failed.push({ groupJid, error: error.message });
        console.error("Send failed for", groupJid, error.message);
      }
      await sleep(1500);
    }

    res.status(failed.length ? 207 : 200).json({
      success: failed.length === 0,
      total: GROUP_JIDS.length,
      sentCount: sent.length,
      failedCount: failed.length,
      sent,
      failed
    });
  } finally {
    isSending = false;
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`WhatsApp server listening on port ${PORT}`);
  connectWhatsApp().catch(console.error);
});