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
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users(
        username TEXT PRIMARY KEY,
        password TEXT,
        admin BOOLEAN DEFAULT false
      );
    `);

    const hash = bcrypt.hashSync("admin123", 8);
    await pool.query(`
      INSERT INTO users(username,password,admin)
      VALUES($1,$2,true)
      ON CONFLICT (username) DO NOTHING
    `, ["admin", hash]);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS logins(
        username TEXT,
        lastActive BIGINT,
        city TEXT,
        region TEXT,
        country TEXT,
        UNIQUE(username)
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages(
        id SERIAL PRIMARY KEY,
        username TEXT,
        message TEXT,
        time BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW())::BIGINT)
      );
    `);

    console.log("✔ Database initialized");
  } catch (err) {
    console.error("Database init error:", err);
  }
}
initDB();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

function escapeHtml(s) {
  return s ? s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;") : "";
}
app.post("/register", async (req, res) => {
  const { username, password } = req.body;
  if(!username || !password)
    return res.json({ success:false, message:"Missing fields" });

  const hash = bcrypt.hashSync(password, 8);
  try {
    await pool.query("INSERT INTO users(username,password) VALUES($1,$2)",
      [username, hash]
    );
    res.json({ success:true, message:"Registered" });
  } catch {
    res.json({ success:false, message:"Username exists" });
  }
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    const r = await pool.query("SELECT * FROM users WHERE username=$1",[username]);
    const row = r.rows[0];
    if(!row) return res.json({success:false,message:"Invalid"});
    if(!bcrypt.compareSync(password,row.password))
      return res.json({success:false,message:"Invalid"});

    res.json({ success:true, username:row.username, admin:row.admin });
  } catch {
    res.json({success:false,message:"Server"});
  }
});
app.get("/messages", async (req, res) => {
  const r = await pool.query("SELECT username,message,time FROM messages ORDER BY time ASC");
  res.json({ success:true, messages:r.rows });
});
// Get users
app.get("/admin/users", async (req,res)=>{
  const r = await pool.query(`
    SELECT username,lastActive,city,region,country,admin 
    FROM users LEFT JOIN logins USING(username)
    ORDER BY username ASC
  `);
  res.json({success:true, users:r.rows});
});

// Delete 1 user
app.post("/admin/delete-user", async (req,res)=>{
  const { adminUsername, username } = req.body;
  const a = await pool.query("SELECT admin FROM users WHERE username=$1",[adminUsername]);
  if(!a.rows[0]?.admin) return res.json({success:false,message:"Unauthorized"});

  await pool.query("DELETE FROM users WHERE username=$1 AND admin=false",[username]);
  await pool.query("DELETE FROM logins WHERE username=$1",[username]);
  res.json({success:true});
});

// Delete messages
app.post("/admin/delete-messages", async (req,res)=>{
  const { adminUsername } = req.body;
  const a = await pool.query("SELECT admin FROM users WHERE username=$1",[adminUsername]);
  if(!a.rows[0]?.admin) return res.json({success:false});

  await pool.query("DELETE FROM messages");
  res.json({success:true});
});

// Delete everything
app.post("/admin/delete-all", async (req,res)=>{
  const { adminUsername } = req.body;
  const a = await pool.query("SELECT admin FROM users WHERE username=$1",[adminUsername]);
  if(!a.rows[0]?.admin) return res.json({success:false});

  await pool.query("DELETE FROM messages");
  await pool.query("DELETE FROM logins");
  await pool.query("DELETE FROM users WHERE admin=false");
  res.json({success:true});
});
const server = app.listen(PORT, ()=>console.log("Running",PORT));
const wss = new WebSocketServer({ server });
const online = new Map();

wss.on("connection", ws=>{
  let current = null;

  ws.on("message", async msg=>{
    const data = JSON.parse(msg);

    if(data.type==="setUser"){
      current = data.username;
      online.set(ws,current);
      await pool.query(`
        INSERT INTO logins(username,lastActive) 
        VALUES($1,$2)
        ON CONFLICT(username) DO UPDATE SET lastActive=$2
      `,[current, Date.now()/1000]);
      broadcastUsers();
    }

    if(data.type==="setAdmin"){
      current = data.username;
      online.set(ws,"admin");
      broadcastUsers();
    }

    if(data.type==="chat"){
      const text = escapeHtml(data.text);
      await pool.query("INSERT INTO messages(username,message) VALUES($1,$2)",[current,text]);
      broadcast({type:"chat",user:current,text});
    }
  });

  ws.on("close",()=>{
    online.delete(ws);
    broadcastUsers();
  });
});

function broadcast(msg){
  const s = JSON.stringify(msg);
  online.forEach((v,ws)=>{
    if(ws.readyState===1) ws.send(s);
  });
}

async function broadcastUsers(){
  const r = await pool.query(`
    SELECT username,lastActive,city,region,country 
    FROM logins
  `);
  broadcast({type:"userList", users:r.rows});
}
