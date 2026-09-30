
import express from "express";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
} from "@whiskeysockets/baileys";
import pino from "pino";
import fs from "fs";
import path from "path";

// ==========================================
// CONFIGURATION
// ==========================================

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 3000);
const AUTH_DIR = process.env.AUTH_DIR || "./auth_info_baileys";
const PAIRING_PHONE = (process.env.PAIRING_PHONE || "").replace(/\D/g, "");

const GROUP_JIDS = (process.env.WHATSAPP_GROUP_JIDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter((id) => id.endsWith("@g.us"));

const logger = pino({ level: "silent" });

// ==========================================
// WHATSAPP STATE
// ==========================================

let sock = null;
let isConnected = false;
let isStarting = false;
let reconnectTimer = null;
let reconnectAttempts = 0;

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ==========================================
// PAIRING CODE
// ==========================================

async function requestPairingCode(currentSock, state) {
  if (state.creds.registered) {
    console.log("An existing WhatsApp session was found.");
    return;
  }

  if (!PAIRING_PHONE) {
    console.error(
      "PAIRING_PHONE is missing. Set it in Railway Variables."
    );
    return;
  }

  if (!/^\d{10,15}$/.test(PAIRING_PHONE)) {
    console.error(
      "PAIRING_PHONE is invalid. Use the country code followed by digits only."
    );
    return;
  }

  // Allow the socket time to initialize.
  await sleep(3000);

  // Do not request a code from an old or disconnected socket.
  if (sock !== currentSock || !currentSock) {
    console.log("Pairing cancelled: WhatsApp socket was replaced.");
    return;
  }

  if (state.creds.registered) {
    console.log("WhatsApp is already registered.");
    return;
  }

  console.log("Requesting WhatsApp pairing code...");

  try {
    const code = await currentSock.requestPairingCode(PAIRING_PHONE);

    // The socket may have been replaced while the request was pending.
    if (sock !== currentSock) {
      console.log("Pairing response received for an old socket.");
      return;
    }

    console.log("----------------------------------------");
    console.log("WHATSAPP PAIRING CODE:", code);
    console.log("Open WhatsApp on your phone.");
    console.log("Go to Linked devices > Link a device.");
    console.log("Choose the option to link with a phone number.");
    console.log("Enter the pairing code shown above.");
    console.log("----------------------------------------");
    console.log("Do not share this code with anyone.");
  } catch (error) {
    console.error(
      "Pairing code request failed:",
      error?.message || error
    );
  }
}

// ==========================================
// WHATSAPP CONNECTION
// ==========================================

async function connectWhatsApp() {
  if (isStarting) {
    console.log("WhatsApp connection is already starting.");
    return;
  }

  isStarting = true;

  try {
    // Ensure the authentication directory exists.
    fs.mkdirSync(path.resolve(AUTH_DIR), { recursive: true });

    const { state, saveCreds } =
      await useMultiFileAuthState(AUTH_DIR);

    const currentSock = makeWASocket({
      auth: state,
      logger,
      browser: ["Church Media Kit", "Chrome", "1.0.0"],
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    });

    sock = currentSock;
    isConnected = false;

    // Save authentication credentials whenever they change.
    currentSock.ev.on("creds.update", saveCreds);

    // Prevent multiple pairing requests for this socket.
    let pairingStarted = false;
    let closeHandled = false;

    // Register connection listener immediately.
    currentSock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === "connecting") {
        console.log("Connecting to WhatsApp...");
      }

      if (connection === "open") {
        isConnected = true;
        reconnectAttempts = 0;

        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }

        console.log("WhatsApp connected successfully.");
      }

      if (connection === "close") {
        isConnected = false;

        // Ignore duplicate close events for this socket.
        if (closeHandled) return;
        closeHandled = true;

        const error = lastDisconnect?.error;
        const statusCode = error?.output?.statusCode;

        console.error("WhatsApp connection closed.");
        console.error("Disconnect status:", statusCode ?? "Unknown");
        console.error(
          "Disconnect reason:",
          error?.message || "No error message supplied"
        );

        // Do not let an old socket affect a newer connection.
        if (sock !== currentSock) return;

        if (statusCode === DisconnectReason.loggedOut) {
          console.error(
            "WhatsApp logged out. Automatic reconnection stopped."
          );
          console.error(
            "Check the authentication session before attempting to pair again."
          );
          return;
        }

        // Reconnect only once for this disconnection.
        if (!reconnectTimer) {
          reconnectAttempts += 1;

          const delay = Math.min(
            5000 * reconnectAttempts,
            30000
          );

          console.log(
            `Reconnecting to WhatsApp in ${delay / 1000} seconds...`
          );

          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;

            if (sock === currentSock) {
              sock = null;
              connectWhatsApp().catch((err) => {
                console.error(
                  "Reconnection failed:",
                  err?.message || err
                );
              });
            }
          }, delay);
        }
      }
    });

    // Request a pairing code only for a new, unregistered session.
    // This runs after the connection listener has been installed.
    if (!state.creds.registered) {
      if (!PAIRING_PHONE) {
        console.error(
          "No pairing code will be requested because PAIRING_PHONE is not set."
        );
      } else if (!pairingStarted) {
        pairingStarted = true;
        requestPairingCode(currentSock, state).catch((error) => {
          console.error(
            "Unexpected pairing error:",
            error?.message || error
          );
        });
      }
    } else {
      console.log("Saved WhatsApp credentials detected.");
      console.log("Attempting to restore the existing session...");
    }
  } catch (error) {
    console.error(
      "Failed to initialize WhatsApp:",
      error?.message || error
    );

    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectWhatsApp().catch((err) => {
          console.error(
            "WhatsApp retry failed:",
            err?.message || err
          );
        });
      }, 10000);
    }
  } finally {
    isStarting = false;
  }
}

// ==========================================
// HTTP ENDPOINTS
// ==========================================

// Health check
app.get("/", (req, res) => {
  res.status(200).json({
    service: "Church Media Kit WhatsApp Sender",
    status: isConnected ? "connected" : "disconnected",
    whatsappConnected: isConnected,
    configuredGroups: GROUP_JIDS.length,
  });
});

// Get WhatsApp groups
app.get("/groups", async (req, res) => {
  if (!sock || !isConnected) {
    return res.status(503).json({
      success: false,
      message: "WhatsApp is not connected.",
    });
  }

  try {
    const groups = await sock.groupFetchAllParticipating();

    const result = Object.entries(groups).map(([jid, group]) => ({
      id: jid,
      name: group.subject || "Unnamed group",
      participants: group.participants?.length || 0,
    }));

    return res.status(200).json({
      success: true,
      count: result.length,
      groups: result,
    });
  } catch (error) {
    console.error(
      "Failed to retrieve groups:",
      error?.message || error
    );

    return res.status(500).json({
      success: false,
      message: "Could not retrieve WhatsApp groups.",
    });
  }
});

// Send announcement to configured groups
app.post("/send-announcement", async (req, res) => {
  if (!sock || !isConnected) {
    return res.status(503).json({
      success: false,
      message: "WhatsApp is not connected.",
    });
  }

  const { message } = req.body || {};

  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({
      success: false,
      message: "A non-empty message is required.",
    });
  }

  if (GROUP_JIDS.length < 5) {
    return res.status(400).json({
      success: false,
      message:
        "At least five valid group JIDs must be configured in WHATSAPP_GROUP_JIDS.",
      configuredGroups: GROUP_JIDS.length,
    });
  }

  const currentSock = sock;
  const results = [];

  for (const jid of GROUP_JIDS) {
    // Stop if the WhatsApp connection changes while sending.
    if (sock !== currentSock || !isConnected) {
      results.push({
        group: jid,
        success: false,
        error: "WhatsApp connection was interrupted.",
      });
      break;
    }

    try {
      await currentSock.sendMessage(jid, {
        text: message.trim(),
      });

      results.push({
        group: jid,
        success: true,
      });

      console.log(`Announcement sent to ${jid}`);

      // Small pause between group messages.
      await sleep(1000);
    } catch (error) {
      console.error(
        `Failed to send announcement to ${jid}:`,
        error?.message || error
      );

      results.push({
        group: jid,
        success: false,
        error: error?.message || "Message sending failed.",
      });
    }
  }

  const successful = results.filter((item) => item.success).length;
  const failed = results.filter((item) => !item.success).length;

  return res.status(failed === 0 ? 200 : 207).json({
    success: failed === 0,
    total: results.length,
    sent: successful,
    failed,
    results,
  });
});

// ==========================================
// START SERVER
// ==========================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Church Media Kit server listening on port ${PORT}`);

  connectWhatsApp().catch((error) => {
    console.error(
      "WhatsApp startup error:",
      error?.message || error
    );
  });
});