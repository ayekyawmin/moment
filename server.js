import express from "express";
import { Pool } from "pg";
import { WebSocketServer } from "ws";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// -------------------- DATABASE --------------------
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL missing");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  // Users table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users(
      username TEXT PRIMARY KEY,
      password TEXT,
      admin BOOLEAN DEFAULT false
    );
  `);

  // Ensure admin exists and password is correct
  const adminPass = "admin123";
  const hash = bcrypt.hashSync(adminPass, 8);
  await pool.query(`
    INSERT INTO users(username,password,admin)
    VALUES($1,$2,true)
    ON CONFLICT (username) DO UPDATE SET password=$2
  `, ["admin", hash]);

  // Logins table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS logins(
      username TEXT,
      ip TEXT,
      country TEXT,
      region TEXT,
      city TEXT,
      org TEXT,
      status TEXT,
      lastActive BIGINT
    );
  `);

  // Messages table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages(
      id SERIAL PRIMARY KEY,
      username TEXT,
      message TEXT,
      type TEXT,
      time BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW())::BIGINT)
    );
  `);

  console.log("✅ Database initialized and admin ensured");
}
initDB();

// -------------------- MIDDLEWARE --------------------
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

function escapeHtml(s) { if (!s) return ""; return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

// -------------------- REGISTER --------------------
app.post("/register", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ success: false, message: "Missing fields" });

  const hash = bcrypt.hashSync(password, 8);
  try {
    await pool.query("INSERT INTO users(username,password) VALUES($1,$2)", [username, hash]);
    res.json({ success: true, message: "Registered successfully" });
  } catch {
    res.json({ success: false, message: "Username already exists" });
  }
});

// -------------------- LOGIN --------------------
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const result = await pool.query("SELECT * FROM users WHERE username=$1", [username]);
  const row = result.rows[0];
  if (!row) return res.json({ success: false, message: "Invalid login" });
  if (!bcrypt.compareSync(password, row.password)) return res.json({ success: false, message: "Invalid login" });
  res.json({ success: true, username: row.username, admin: row.admin });
});

// -------------------- GET MESSAGES --------------------
app.get("/messages", async (req, res) => {
  const result = await pool.query("SELECT username,message,time FROM messages ORDER BY time ASC");
  res.json({ success: true, messages: result.rows });
});

// -------------------- ADMIN ENDPOINTS --------------------
app.get("/admin/messages", async (req, res) => {
  const result = await pool.query("SELECT username,message,time FROM messages ORDER BY time ASC");
  res.json({ success: true, messages: result.rows });
});

app.post("/admin/delete-messages", async (req, res) => {
  const { username } = req.body;
  const result = await pool.query("SELECT admin FROM users WHERE username=$1", [username]);
  if (!result.rows[0]?.admin) return res.json({ success: false, message: "Unauthorized" });
  await pool.query("DELETE FROM messages");
  res.json({ success: true, message: "All messages deleted" });
});

app.post("/admin/delete-all", async (req, res) => {
  const { username } = req.body;
  const result = await pool.query("SELECT admin FROM users WHERE username=$1", [username]);
  if (!result.rows[0]?.admin) return res.json({ success: false, message: "Unauthorized" });
  await pool.query("DELETE FROM messages");
  await pool.query("DELETE FROM logins");
  res.json({ success: true, message: "All messages and logins deleted" });
});

app.post("/admin/update-username", async (req, res) => {
  const { adminUsername, newUsername } = req.body;
  const result = await pool.query("SELECT admin FROM users WHERE username=$1", [adminUsername]);
  if (!result.rows[0]?.admin) return res.json({ success: false, message: "Unauthorized" });
  await pool.query("UPDATE users SET username=$1 WHERE username=$2", [newUsername, adminUsername]);
  res.json({ success: true, message: "Username updated" });
});

app.post("/admin/update-password", async (req, res) => {
  const { adminUsername, newPassword } = req.body;
  const result = await pool.query("SELECT admin FROM users WHERE username=$1", [adminUsername]);
  if (!result.rows[0]?.admin) return res.json({ success: false, message: "Unauthorized" });
  const hash = bcrypt.hashSync(newPassword, 8);
  await pool.query("UPDATE users SET password=$1 WHERE username=$2", [hash, adminUsername]);
  res.json({ success: true, message: "Password updated" });
});

// -------------------- WEBSOCKET --------------------
const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
const wss = new WebSocketServer({ server });
const clients = new Map();

wss.on("connection", ws => {
  let currentUser = null;
  let isAdmin = false;

  ws.on("message", async msg => {
    try {
      const data = JSON.parse(msg);

      // Normal user
      if (data.type === "setUser") {
        currentUser = data.username;
        clients.set(ws, { username: currentUser, admin: false });
      }

      // Admin
      if (data.type === "setAdmin") {
        isAdmin = true;
        clients.set(ws, { username: "admin", admin: true });
        broadcastUserList();
      }

      // Chat
      if (data.type === "chat") {
        const text = escapeHtml(data.text);
        if (!currentUser && !isAdmin) return;
        const user = isAdmin ? "admin" : currentUser;
        await pool.query("INSERT INTO messages(username,message) VALUES($1,$2)", [user, text]);
        broadcast({ type: "chat", user, text });
      }
    } catch (err) {
      console.error(err);
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    broadcastUserList();
  });
});

function broadcast(msg) {
  const str = JSON.stringify(msg);
  clients.forEach(({ admin }, ws) => {
    if (ws.readyState === 1) ws.send(str);
  });
}

async function broadcastUserList() {
  const res = await pool.query("SELECT username,status,lastActive,ip,city,region,country FROM logins");
  const users = res.rows.map(u => ({
    username: u.username,
    status: u.status || "offline",
    lastActive: u.lastActive,
    city: u.city,
    region: u.region,
    country: u.country
  }));
  broadcast({ type: "userList", users });
}




