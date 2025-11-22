/* main.js — client logic for login/register/chat */
let ws = null;
let username = null;

const $ = id => document.getElementById(id);

// ----------------- UI EVENT BINDING -----------------
document.addEventListener("DOMContentLoaded", () => {
  $("loginBtn").onclick = login;
  $("showReg").onclick = e => { e.preventDefault(); $("loginArea").style.display="none"; $("registerArea").style.display="block"; };
  $("backToLogin").onclick = e => { e.preventDefault(); $("registerArea").style.display="none"; $("loginArea").style.display="block"; };
  $("regBtn").onclick = register;
  $("sendBtn").onclick = sendMessage;
  $("msgInput").addEventListener("keypress", e => { if(e.key==='Enter') sendMessage(); });
});

// ----------------- REGISTER -----------------
async function register() {
  const u = $("regUser").value.trim();
  const p = $("regPass").value.trim();
  if (!u || !p) { $("registerMessage").innerText = "Enter username & password"; return; }

  const res = await fetch("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: u, password: p })
  });

  const data = await res.json();
  $("registerMessage").innerText = data.message;

  if (data.success) {
    $("registerArea").style.display = "none";
    $("loginArea").style.display = "block";
  }
}

// ----------------- LOGIN -----------------
async function login() {
  const u = $("loginUser").value.trim();
  const p = $("loginPass").value.trim();
  if (!u || !p) { $("loginMessage").innerText = "Enter username & password"; return; }

  const res = await fetch("/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: u, password: p })
  });

  const data = await res.json();

  if (!data.success) {
    $("loginMessage").innerText = data.message;
    return;
  }

  if (data.admin) {
    // Redirect admin to admin.html
    window.location.href = "/admin.html";
    return;
  }

  // Normal user login
  username = data.username;
  $("loginArea").style.display = "none";
  $("registerArea").style.display = "none";
  $("chatArea").style.display = "block";
  $("who").innerText = username;

  startWebSocket();
}

// ----------------- WEBSOCKET -----------------
function startWebSocket() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}`);

  ws.onopen = async () => {
    ws.send(JSON.stringify({ type: "setUser", username }));

    // Load chat history
    const res = await fetch("/messages");
    const data = await res.json();
    if (data.success) {
      data.messages.forEach(m => appendChat(m.username, m.message));
    }
  };

  ws.onmessage = e => {
    const data = JSON.parse(e.data);
    if (data.type === "chat") {
      appendChat(data.user, data.text);
    }
  };

  ws.onclose = () => console.log("WebSocket closed");
}

// ----------------- CHAT FUNCTIONS -----------------
function appendChat(user, text) {
  const msgs = $("messages");
  const div = document.createElement("div");
  div.className = "chat-row";
  div.innerHTML = `<strong>${escapeHtml(user)}</strong>: ${escapeHtml(text)}`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

function sendMessage() {
  const txt = $("msgInput").value.trim();
  if (!txt || !ws || ws.readyState !== 1) return;

  ws.send(JSON.stringify({ type: "chat", text: txt }));
  $("msgInput").value = "";
  $("msgInput").focus();
}

// ----------------- UTILS -----------------
function escapeHtml(s) {
  if (!s) return "";
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}






