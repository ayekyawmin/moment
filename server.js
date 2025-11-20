
import express from "express";
import { Pool } from "pg";
import { WebSocketServer } from "ws";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";

dotenv.config(); // Load .env

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------- POSTGRES (SUPABASE) ----------------
if (!process.env.DATABASE_URL) {
  console.error("❌ ERROR: DATABASE_URL not found in .env");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ---------------- STATIC FILES ----------------
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------------- DATABASE INIT ----------------
async function initDB() {
  try {
    // Users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users(
        username TEXT PRIMARY KEY,
        password TEXT,
        admin BOOLEAN DEFAULT false
      );
    `);

    // Only insert default admin if it doesn't exist
    const adminCheck = await pool.query(`SELECT * FROM users WHERE username=$1`, ["admin"]);
    if (adminCheck.rowCount === 0) {
      const defaultPass = "admin123";
      const hash = bcrypt.hashSync(defaultPass, 8);
      await pool.query(`INSERT INTO users(username,password,admin) VALUES($1,$2,true)`, ["admin", hash]);
      console.log(`✔ Admin created: username='admin' password='${defaultPass}'`);
    } else {
      console.log("✔ Admin already exists, skipping creation");
    }

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

    console.log("✔ Database initialization complete");
  } catch (err) {
    console.error("❌ Database init error:", err);
  }
}

initDB();

// ---------------- HELPERS ----------------
function isLocalIp(ip) {
  if (!ip) return true;
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    ip.startsWith("172.")
  );
}

async function lookupIPInfo(ip) {
  if (!ip || isLocalIp(ip)) {
    return { ip: ip || "local", country_name: "Local", region: "Local", city: "Local", org: "Localhost" };
  }
  try {
    const res = await fetch(`https://ipapi.co/${ip}/json/`);
    const data = await res.json();
    return {
      ip,
      country_name: data.country_name || "Unknown",
      region: data.region || "Unknown",
      city: data.city || "Unknown",
      org: data.org || "Unknown"
    };
  } catch {
    return { ip, country_name: "Unknown", region: "Unknown", city: "Unknown", org: "Unknown" };
  }
}

// ---------------- REGISTER ----------------
app.post("/register", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.json({ success: false, message: "Missing fields" });

  const hash = bcrypt.hashSync(password, 8);

  try {
    await pool.query("INSERT INTO users(username,password) VALUES($1,$2)", [username, hash]);
    res.json({ success: true, message: "Registered" });
  } catch {
    res.json({ success: false, message: "Username exists" });
  }
});

// ---------------- LOGIN ----------------
app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  const result = await pool.query("SELECT * FROM users WHERE username=$1", [username]);
  const row = result.rows[0];
  if (!row) return res.json({ success: false, message: "Invalid login" });

  const match = bcrypt.compareSync(password, row.password);
  if (!match) return res.json({ success: false, message: "Invalid login" });

  let ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || req.ip;
  ip = ip.replace("::ffff:", "");

  const geo = await lookupIPInfo(ip);

  await pool.query(
    `INSERT INTO logins(username,ip,country,region,city,org,status,lastActive)
     VALUES($1,$2,$3,$4,$5,$6,'online',EXTRACT(EPOCH FROM NOW())::BIGINT)`,
    [username, ip, geo.country_name, geo.region, geo.city, geo.org]
  );

  res.json({ success: true, username, admin: row.admin });
});

// ---------------- ADMIN ----------------
app.post("/deleteAllMessages", async (req, res) => {
  const { username } = req.body;
  const result = await pool.query("SELECT admin FROM users WHERE username=$1", [username]);
  if (!result.rows[0]?.admin)
    return res.json({ success: false, message: "Unauthorized" });

  await pool.query("DELETE FROM messages");
  await pool.query("DELETE FROM logins");
  res.json({ success: true });
});

// ---------------- WEBSOCKETS ----------------
const server = app.listen(PORT, () => console.log(`Server running on PORT ${PORT}`));
const wss = new WebSocketServer({ server });

function broadcast(obj) {
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify(obj)); });
}

async function sendAdminList() {
  const result = await pool.query("SELECT * FROM logins");
  const rows = result.rows;
  wss.clients.forEach(c => {
    if (c.isAdmin && c.readyState === 1)
      c.send(JSON.stringify({ type: "userList", users: rows }));
  });
}

wss.on("connection", (ws) => {
  ws.username = null;
  ws.isAdmin = false;

  ws.on("message", async (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    if (data.type === "setUser") ws.username = data.username;
    if (data.type === "setAdmin") { ws.isAdmin = true; await sendAdminList(); }

    if (data.type === "chat") {
      if (!ws.username) return;
      await pool.query("INSERT INTO messages(username,message,type) VALUES($1,$2,'chat')", [ws.username, data.text]);
      broadcast({ type: "chat", user: ws.username, text: data.text });
    }
  });

  ws.on("close", async () => {
    if (!ws.username) return;
    await pool.query(
      "UPDATE logins SET status='offline', lastActive=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE username=$1",
      [ws.username]
    );
    await sendAdminList();
  });
});

