import express from "express";
import sqlite3 from "sqlite3";
import { WebSocketServer } from "ws";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
// When deployed on Render attach disk /data; set RENDER env var automatically on Render
const DB_PATH = process.env.RENDER ? "/data" : ".";

const usersDB = new sqlite3.Database(`${DB_PATH}/users.db`);
const chatDB = new sqlite3.Database(`${DB_PATH}/chat.db`);

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------------- DB INIT ----------------
usersDB.serialize(() => {
  usersDB.run(`
    CREATE TABLE IF NOT EXISTS users(
      username TEXT PRIMARY KEY,
      password TEXT,
      admin INTEGER DEFAULT 0
    )
  `);

  // Create default admin if not exists (Option A)
  const defaultAdmin = "admin";
  const defaultPass = "admin123";
  const hash = bcrypt.hashSync(defaultPass, 8);
  usersDB.run(
    `INSERT OR IGNORE INTO users(username,password,admin) VALUES(?,?,1)`,
    [defaultAdmin, hash],
    (err) => {
      if (!err) console.log(`Ensured admin account exists: username='${defaultAdmin}' password='${defaultPass}'`);
    }
  );
});

chatDB.serialize(() => {
  chatDB.run(`
    CREATE TABLE IF NOT EXISTS logins(
      username TEXT,
      ip TEXT,
      country TEXT,
      region TEXT,
      city TEXT,
      org TEXT,
      status TEXT,
      lastActive INTEGER
    )
  `);

  chatDB.run(`
    CREATE TABLE IF NOT EXISTS messages(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT,
      message TEXT,
      type TEXT,
      time INTEGER DEFAULT (strftime('%s','now'))
    )
  `);
});

// ---------------- helpers ----------------
function isLocalIp(ip) {
  if (!ip) return true;
  if (ip === "127.0.0.1" || ip === "::1") return true;
  if (ip.startsWith("10.") || ip.startsWith("192.168.") || ip.startsWith("172.")) return true;
  return false;
}

async function lookupIPInfo(ip) {
  // ip param should not contain ::ffff: prefix
  if (!ip || isLocalIp(ip)) {
    return {
      ip: ip || "local",
      country_name: "Local",
      region: "Local",
      city: "Local",
      org: "Localhost"
    };
  }
  try {
    // Node 18+ has global fetch
    const res = await fetch(`https://ipapi.co/${ip}/json/`);
    if (!res.ok) throw new Error("failed");
    const data = await res.json();
    return data;
  } catch (err) {
    console.error("IP lookup error:", err.message);
    return {
      ip,
      country_name: "Unknown",
      region: "Unknown",
      city: "Unknown",
      org: "Unknown"
    };
  }
}

// ---------------- REST API ----------------

// Register new user (normal user)
app.post("/register", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ success: false, message: "Missing fields" });

  const hash = bcrypt.hashSync(password, 8);
  usersDB.run(
    "INSERT INTO users(username,password) VALUES(?,?)",
    [username, hash],
    (err) => {
      if (err) {
        console.error("Register error:", err.message);
        return res.json({ success: false, message: "Username already exists" });
      }
      res.json({ success: true, message: "Registered successfully" });
    }
  );
});

// Login by username+password
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ success: false, message: "Missing fields" });

  usersDB.get("SELECT * FROM users WHERE username = ?", [username], async (err, row) => {
    if (err) {
      console.error("Login DB error:", err);
      return res.json({ success: false, message: "Server error" });
    }
    if (!row) return res.json({ success: false, message: "Invalid login" });

    const match = bcrypt.compareSync(password, row.password);
    if (!match) return res.json({ success: false, message: "Invalid login" });

    // get client IP (works behind proxies like Render)
    let ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || req.ip;
    ip = (ip || "").replace("::ffff:", "");

    // Lookup geo (safe for local IP)
    const geo = await lookupIPInfo(ip);

    chatDB.run(
      `INSERT INTO logins(username,ip,country,region,city,org,status,lastActive)
       VALUES(?,?,?,?,?,?,?,?)`,
      [
        username,
        ip,
        geo.country_name || "Unknown",
        geo.region || "Unknown",
        geo.city || "Unknown",
        geo.org || "Unknown",
        "online",
        Date.now()
      ],
      (e) => {
        if (e) console.error("logins insert error:", e.message);
      }
    );

    res.json({ success: true, username, admin: row.admin === 1 });
  });
});

// Admin: delete all messages/logins (must send admin username)
app.post("/deleteAllMessages", (req, res) => {
  const { username } = req.body;
  if (!username) return res.json({ success: false, message: "Missing username" });

  usersDB.get("SELECT admin FROM users WHERE username = ?", [username], (err, row) => {
    if (err || !row || row.admin !== 1) return res.json({ success: false, message: "Unauthorized" });

    chatDB.serialize(() => {
      chatDB.run("DELETE FROM messages");
      chatDB.run("DELETE FROM logins");
    });

    res.json({ success: true, message: "Deleted all messages and cleared login info" });
  });
});

// Admin: change admin username (requires current admin username in body to authorize)
app.post("/admin/update-username", (req, res) => {
  const { adminUsername, newUsername } = req.body;
  if (!adminUsername || !newUsername) return res.json({ success: false, message: "Missing fields" });

  usersDB.get("SELECT admin FROM users WHERE username = ?", [adminUsername], (err, row) => {
    if (err || !row || row.admin !== 1) return res.json({ success: false, message: "Unauthorized" });

    // update admin username in users table and update logins table
    usersDB.run("UPDATE users SET username = ? WHERE username = ?", [newUsername, adminUsername], function (e) {
      if (e) return res.json({ success: false, message: "Failed to update username" });

      chatDB.run("UPDATE logins SET username = ? WHERE username = ?", [newUsername, adminUsername], (ee) => {
        if (ee) console.error("update logins error:", ee.message);
        res.json({ success: true, message: "Admin username updated" });
      });
    });
  });
});

// Admin: change admin password
app.post("/admin/update-password", (req, res) => {
  const { adminUsername, newPassword } = req.body;
  if (!adminUsername || !newPassword) return res.json({ success: false, message: "Missing fields" });

  usersDB.get("SELECT admin FROM users WHERE username = ?", [adminUsername], (err, row) => {
    if (err || !row || row.admin !== 1) return res.json({ success: false, message: "Unauthorized" });

    const hash = bcrypt.hashSync(newPassword, 8);
    usersDB.run("UPDATE users SET password = ? WHERE username = ?", [hash, adminUsername], (e) => {
      if (e) return res.json({ success: false, message: "Failed to update password" });
      res.json({ success: true, message: "Admin password updated" });
    });
  });
});

// ---------------- WEBSOCKET ----------------
const server = app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
const wss = new WebSocketServer({ server });

function broadcast(obj) {
  wss.clients.forEach(c => {
    if (c.readyState === 1) c.send(JSON.stringify(obj));
  });
}

function sendAdminListToAdmins() {
  chatDB.all("SELECT * FROM logins", (err, rows) => {
    if (err) { console.error("sendAdminList err:", err); return; }
    // Only send userList to clients that flagged isAdmin
    wss.clients.forEach(c => {
      if (c.isAdmin && c.readyState === 1) {
        c.send(JSON.stringify({ type: "userList", users: rows }));
      }
    });
  });
}

wss.on("connection", (ws) => {
  ws.username = null;
  ws.isAdmin = false;

  ws.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    if (data.type === "setUser") {
      ws.username = data.username;
    }

    if (data.type === "setAdmin") {
      // client says it's admin - mark it and send admin list
      ws.isAdmin = true;
      sendAdminListToAdmins();
    }

    if (data.type === "chat") {
      if (!ws.username) return;
      // save message
      chatDB.run("INSERT INTO messages (username,message,type) VALUES (?,?,?)", [ws.username, data.text, "chat"], (e) => {
        if (e) console.error("save message err:", e.message);
      });
      broadcast({ type: "chat", user: ws.username, text: data.text });
    }
  });

  ws.on("close", () => {
    if (!ws.username) return;
    // mark offline
    chatDB.run("UPDATE logins SET status = ?, lastActive = ? WHERE username = ?", ["offline", Date.now(), ws.username], (e) => {
      if (e) console.error("update offline err:", e.message);
      sendAdminListToAdmins();
    });
  });
});
