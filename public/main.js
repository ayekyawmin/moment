/* main.js — client logic for login/register/chat/admin */
let ws = null;
let username = null;
let isAdmin = false;

const $ = id => document.getElementById(id);

// UI wiring
document.addEventListener("DOMContentLoaded", () => {
  // login
  $("loginBtn").onclick = login;
  $("showReg").onclick = (e) => { e.preventDefault(); $("loginArea").style.display="none"; $("registerArea").style.display="block"; };
  $("backToLogin").onclick = (e) => { e.preventDefault(); $("registerArea").style.display="none"; $("loginArea").style.display="block"; };
  $("regBtn").onclick = register;
  $("sendBtn").onclick = sendMessage;
  $("msgInput").addEventListener("keypress", (e)=>{ if (e.key==='Enter') sendMessage(); });

  $("deleteAllBtn").onclick = deleteAllMessages;
  $("updateAdmNameBtn").onclick = updateAdminName;
  $("updateAdmPassBtn").onclick = updateAdminPassword;
});

async function register(){
  const u = $("regUser").value.trim();
  const p = $("regPass").value.trim();
  if(!u||!p){ $("registerMessage").innerText = "Enter username & password"; return; }
  const res = await fetch("/register", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:u,password:p})});
  const data = await res.json();
  $("registerMessage").innerText = data.message;
  if(data.success){ $("registerArea").style.display="none"; $("loginArea").style.display="block"; }
}

async function login(){
  const u = $("loginUser").value.trim();
  const p = $("loginPass").value.trim();
  if(!u||!p){ $("loginMessage").innerText="Enter username & password"; return; }
  const res = await fetch("/login", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:u,password:p})});
  const data = await res.json();
  if(!data.success){ $("loginMessage").innerText = data.message; return; }

  username = data.username;
  isAdmin = data.admin;
  $("loginArea").style.display="none";
  $("registerArea").style.display="none";
  if(isAdmin){
    $("adminArea").style.display="block";
  } else {
    $("chatArea").style.display="block";
  }
  $("who").innerText = username;
  startWebSocket();
}

function startWebSocket(){
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}`);

  ws.onopen = () => {
    if(isAdmin) ws.send(JSON.stringify({type:"setAdmin"}));
    else ws.send(JSON.stringify({type:"setUser", username}));
  };
  ws.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if(data.type === "chat"){
      appendChat(data.user, data.text);
    } else if(data.type === "userList" && isAdmin){
      renderAdminUsers(data.users);
    }
  };
  ws.onclose = ()=>console.log("ws closed");
}

function appendChat(user, text){
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
  ws.send(JSON.stringify({type:"chat", text:txt}));
  $("msgInput").value = "";
  $("msgInput").focus();
}

// Admin functions
function renderAdminUsers(users){
  const tbody = $("usersTableBody");
  tbody.innerHTML = "";
  users.forEach(u => {
    const tr = document.createElement("tr");
    const last = u.lastActive ? new Date(u.lastActive).toLocaleString() : "-";
    const loc = `${u.city || "-"}, ${u.region || "-"}, ${u.country || "-"}`;
    tr.innerHTML = `<td>${escapeHtml(u.username)}</td><td>${escapeHtml(u.status)}</td><td>${escapeHtml(last)}</td><td>${escapeHtml(loc)}</td>`;
    tbody.appendChild(tr);
  });
}

async function deleteAllMessages(){
  if(!confirm("Delete all messages and clear login info?")) return;
  const res = await fetch("/deleteAllMessages", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username})});
  const data = await res.json();
  $("adminStatus").innerText = data.message;
  // reload user list
  if(ws && ws.readyState===1) ws.send(JSON.stringify({type:"setAdmin"}));
}

async function updateAdminName(){
  const newName = $("newAdminName").value.trim();
  if(!newName){ $("adminStatus").innerText = "Enter new admin username"; return; }
  const res = await fetch("/admin/update-username", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({adminUsername: username, newUsername: newName})});
  const data = await res.json();
  $("adminStatus").innerText = data.message;
  if(data.success){
    // if admin renamed themselves, update local username
    username = newName;
    $("who").innerText = username;
  }
}

async function updateAdminPassword(){
  const newPass = $("newAdminPass").value.trim();
  if(!newPass){ $("adminStatus").innerText = "Enter new password"; return; }
  const res = await fetch("/admin/update-password", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({adminUsername: username, newPassword: newPass})});
  const data = await res.json();
  $("adminStatus").innerText = data.message;
  if(data.success) $("newAdminPass").value = "";
}

// simple escape to avoid HTML injection in UI
function escapeHtml(s){ if(!s) return ""; return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }




