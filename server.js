import express from "express";
import sqlite3 from "sqlite3";
import { WebSocketServer } from "ws";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------
// PORT + DATABASE LOCATION
// ---------------------------------------------------------
const app = express();
const PORT = process.env.PORT || 3000;

// Render allows writing only inside /var/data
// Local use → database saved in project folder
const DB_FOLDER = process.env.RENDER ? "/var/data" : ".";

const usersDB = new sqlite3.Database(`${DB_FOLDER}/users.db`);
const chatDB = new sqlite3.Database(`${DB_FOLDER}/chat.db`);

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------
// DATABASE INITIALIZATION
// ---------------------------------------------------------
usersDB.serialize(() => {
  usersDB.run(`
    CREATE TABLE IF NOT EXISTS users(
      username TEXT PRIMARY KEY,
      password TEXT,
      admin INTEGER DEFAULT 0
    )
  `);

  // Create default admin at first start
  const defaultAdmin = "admin";
  const defaultPass = "admin123";
  const hash = bcrypt.hashSync(defaultPass, 8);

  usersDB.run(
    `INSERT OR IGNORE INTO users(username,password,admin) VALUES(?,?,1)`,
    [defaultAdmin, hash],
    (err) => {
      if (!err) {
        console.log(`Admin ensured: username='${defaultAdmin}' password='${defaultPass}'`);
      }
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

// ---------------------------------------------------------
// HELPER FUNCTIONS
// ---------------------------------------------------------
function isLocalIp(ip) {
  if (!ip) return true;
  if (ip === "127.0.0.1" || ip === "::1") return true;
  if (ip.startsWith("10.") || ip.startsWith("192.168.") || ip.startsWith("172.")) return true;
  return false;
}

async function lookupIPInfo(ip) {
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
    const res = await fetch(`https://ipapi.co/${ip}/json/`);
    if (!res.ok) throw new Error("bad response");
    const data = await res.json();

    return {
      ip,
      country_name: data.country_name || "Unknown",
      region: data.region || "Unknown",
      city: data.city || "Unknown",
      org: data.org || "Unknown"
    };
  } catch (err) {
    console.log("Geo lookup failed:", err.message);

    return {
      ip,
      country_name: "Unknown",
      region: "Unknown",
      city: "Unknown",
      org: "Unknown"
    };
  }
}

// ---------------------------------------------------------
// USER REGISTER
// ---------------------------------------------------------
app.post("/register", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.json({ success: false, message: "Missing fields" });

  const hash = bcrypt.hashSync(password, 8);

  usersDB.run(
    "INSERT INTO users(username,password) VALUES(?,?)",
    [username, hash],
    (err) => {
      if (err) return res.json({ success: false, message: "Username exists" });

      res.json({ success: true, message: "Registered" });
    }
  );
});

// ---------------------------------------------------------
// USER LOGIN
// ---------------------------------------------------------
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.json({ success: false, message: "Missing fields" });

  usersDB.get("SELECT * FROM users WHERE username = ?", [username], async (err, row) => {
    if (!row) return res.json({ success: false, message: "Invalid login" });

    const match = bcrypt.compareSync(password, row.password);
    if (!match) return res.json({ success: false, message: "Invalid login" });

    let ip = req.headers["x-forwarded-for"]?.split(",")[0] ||
             req.socket.remoteAddress ||
             req.ip;

    ip = (ip || "").replace("::ffff:", "");

    const geo = await lookupIPInfo(ip);

    chatDB.run(
      `INSERT INTO logins(username,ip,country,region,city,org,status,lastActive)
       VALUES(?,?,?,?,?,?,?,?)`,
      [
        username,
        ip,
        geo.country_name,
        geo.region,
        geo.city,
        geo.org,
        "online",
        Date.now()
      ]
    );

    res.json({ success: true, username, admin: row.admin === 1 });
  });
});

// ---------------------------------------------------------
// ADMIN FUNCTIONS
// ---------------------------------------------------------
app.post("/deleteAllMessages", (req, res) => {
  const { username } = req.body;
  if (!username) return res.json({ success: false });

  usersDB.get("SELECT admin FROM users WHERE username=?", [username], (err, row) => {
    if (!row || row.admin !== 1)
      return res.json({ success: false, message: "Unauthorized" });

    chatDB.run("DELETE FROM messages");
    chatDB.run("DELETE FROM logins");

    res.json({ success: true });
  });
});

// Update admin username
app.post("/admin/update-username", (req, res) => {
  const { adminUsername, newUsername } = req.body;

  usersDB.get("SELECT admin FROM users WHERE username=?", [adminUsername], (err, row) => {
    if (!row || row.admin !== 1)
      return res.json({ success: false });

    usersDB.run(
      "UPDATE users SET username=? WHERE username=?",
      [newUsername, adminUsername],
      () => {
        chatDB.run(
          "UPDATE logins SET username=? WHERE username=?",
          [newUsername, adminUsername]
        );
        res.json({ success: true });
      }
    );
  });
});

// Update admin password
app.post("/admin/update-password", (req, res) => {
  const { adminUsername, newPassword } = req.body;

  usersDB.get("SELECT admin FROM users WHERE username=?", [adminUsername], (err, row) => {
    if (!row || row.admin !== 1)
      return res.json({ success: false });

    const hash = bcrypt.hashSync(newPassword, 8);

    usersDB.run(
      "UPDATE users SET password=? WHERE username=?",
      [hash, adminUsername],
      () => res.json({ success: true })
    );
  });
});

// ---------------------------------------------------------
// WEBSOCKETS
// ---------------------------------------------------------
const server = app.listen(PORT, () =>
  console.log(`Server running on PORT ${PORT}`)
);

const wss = new WebSocketServer({ server });

function broadcast(obj) {
  wss.clients.forEach((c) => {
    if (c.readyState === 1) c.send(JSON.stringify(obj));
  });
}

function sendAdminList() {
  chatDB.all("SELECT * FROM logins", (err, rows) => {
    wss.clients.forEach((c) => {
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
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    if (data.type === "setUser") ws.username = data.username;

    if (data.type === "setAdmin") {
      ws.isAdmin = true;
      sendAdminList();
    }

    if (data.type === "chat") {
      if (!ws.username) return;

      chatDB.run(
        "INSERT INTO messages(username,message,type) VALUES(?,?,?)",
        [ws.username, data.text, "chat"]
      );

      broadcast({ type: "chat", user: ws.username, text: data.text });
    }
  });

  ws.on("close", () => {
    if (!ws.username) return;

    chatDB.run(
      "UPDATE logins SET status=?, lastActive=? WHERE username=?",
      ["offline", Date.now(), ws.username],
      () => sendAdminList()
    );
  });
});
