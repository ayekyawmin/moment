let ws = null;
let username = null;
let isAdmin = false;

const $ = id => document.getElementById(id);

document.addEventListener("DOMContentLoaded", () => {
  // Clear any pre-filled values
  $("loginUser").value = "";
  $("loginPass").value = "";
  $("regUser").value = "";
  $("regPass").value = "";

  // Login
  $("loginBtn").onclick = login;

  // Toggle register/login views
  $("showReg").onclick = e => { e.preventDefault(); $("loginArea").style.display="none"; $("registerArea").style.display="block"; };
  $("backToLogin").onclick = e => { e.preventDefault(); $("registerArea").style.display="none"; $("loginArea").style.display="block"; };

  // Register
  $("regBtn").onclick = register;

  // Chat send
  $("sendBtn").onclick = sendMessage;
  $("msgInput").addEventListener("keypress", e => { if(e.key==="Enter") sendMessage(); });
});

async function register() {
  const u = $("regUser").value.trim();
  const p = $("regPass").value.trim();
  if (!u || !p) {
    $("registerMessage").innerText = "Enter username & password";
    $("registerMessage").style.color = "red";
    return;
  }

  const res = await fetch("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: u, password: p })
  });

  const data = await res.json();

  if (data.success) {
    $("registerMessage").innerText = "You are registered! Log in now.";
    $("registerMessage").style.color = "green";
    // Clear input fields
    $("regUser").value = "";
    $("regPass").value = "";
    // Switch back to login after 2 seconds
    setTimeout(() => {
      $("registerArea").style.display = "none";
      $("loginArea").style.display = "block";
      $("registerMessage").innerText = "";
    }, 3000);
  } else {
    $("registerMessage").innerText = data.message;
    $("registerMessage").style.color = "red";
  }
}


async function login(){
  const u = $("loginUser").value.trim();
  const p = $("loginPass").value.trim();
  if(!u||!p){ $("loginMessage").innerText="Enter username & password"; return; }

  const res = await fetch("/login", {
    method:"POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({username:u,password:p})
  });

  const data = await res.json();
  if(!data.success){ $("loginMessage").innerText = data.message; return; }

  username = data.username;
  isAdmin = data.admin;

  $("loginArea").style.display="none";
  $("registerArea").style.display="none";

  if(isAdmin){
    window.location.href = "/admin.html"; // redirect admin to admin page
  } else {
    $("chatArea").style.display="block";
    $("who").innerText = username;
    startWebSocket();
  }
}

// ---------------- WebSocket ----------------
function startWebSocket(){
  const proto = location.protocol==="https:"?"wss:":"ws:";
  ws = new WebSocket(`${proto}//${location.host}`);

  ws.onopen = async () => {
    if(!isAdmin) ws.send(JSON.stringify({type:"setUser",username}));
    // Load chat history
    const res = await fetch("/messages");
    const data = await res.json();
    if(data.success) data.messages.forEach(m => appendChat(m.username,m.message));
  };

  ws.onmessage = e => {
    const data = JSON.parse(e.data);
    if(data.type==="chat") appendChat(data.user,data.text);
  };
}

function appendChat(user,text){
  const msgs = $("messages");
  const div = document.createElement("div");
  div.className = "chat-row";
  div.innerHTML = `<strong>${escapeHtml(user)}</strong>: ${escapeHtml(text)}`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

function sendMessage(){
  const txt = $("msgInput").value.trim();
  if(!txt||!ws||ws.readyState!==1) return;
  ws.send(JSON.stringify({type:"chat",text:txt}));
  $("msgInput").value = "";
  $("msgInput").focus();
}

// ---------------- Helper ----------------
function escapeHtml(s){ if(!s) return ""; return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }







