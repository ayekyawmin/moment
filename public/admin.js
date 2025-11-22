let ws = null;
let username = "admin";
const $ = id => document.getElementById(id);

document.addEventListener("DOMContentLoaded", () => {
  startWebSocket();
  loadAdminMessages();

  $("deleteMsgsBtn").onclick = deleteMessagesOnly;
  $("deleteAllBtn").onclick = deleteAllMessages;
  $("updateAdmNameBtn").onclick = updateAdminName;
  $("updateAdmPassBtn").onclick = updateAdminPassword;
});

function startWebSocket() {
  const proto = location.protocol==="https:"?"wss:":"ws:";
  ws = new WebSocket(`${proto}//${location.host}`);
  ws.onopen = () => ws.send(JSON.stringify({ type:"setAdmin" }));
  ws.onmessage = e => {
    const data = JSON.parse(e.data);
    if(data.type==="userList") renderAdminUsers(data.users);
  };
}

function renderAdminUsers(users){
  const tbody = $("usersTableBody");
  tbody.innerHTML = "";
  users.forEach(u=>{
    const last = u.lastActive?new Date(u.lastActive*1000).toLocaleString():"-";
    const loc = `${u.city||"-"}, ${u.region||"-"}, ${u.country||"-"}`;
    tbody.innerHTML += `<tr><td>${escapeHtml(u.username)}</td><td>${escapeHtml(u.status)}</td><td>${escapeHtml(last)}</td><td>${escapeHtml(loc)}</td></tr>`;
  });
}

async function loadAdminMessages(){
  const res = await fetch("/admin/messages");
  const data = await res.json();
  const tbody = $("msgHistoryBody");
  tbody.innerHTML="";
  if(data.success) data.messages.forEach(m=>{
    tbody.innerHTML+=`<tr><td>${escapeHtml(m.username)}</td><td>${escapeHtml(m.message)}</td><td>${new Date(m.time*1000).toLocaleString()}</td></tr>`;
  });
}

async function deleteMessagesOnly(){
  if(!confirm("Delete only chat messages?")) return;
  const res = await fetch("/admin/delete-messages",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username})});
  const data = await res.json();
  $("adminStatus").innerText = data.message;
  loadAdminMessages();
}

async function deleteAllMessages(){
  if(!confirm("Delete ALL messages and logins?")) return;
  const res = await fetch("/admin/delete-all",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username})});
  const data = await res.json();
  $("adminStatus").innerText = data.message;
  loadAdminMessages();
  if(ws && ws.readyState===1) ws.send(JSON.stringify({type:"setAdmin"}));
}

async function updateAdminName(){
  const newName = $("newAdminName").value.trim();
  if(!newName){ $("adminStatus").innerText="Enter new username"; return; }
  const res = await fetch("/admin/update-username",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({adminUsername:username,newUsername:newName})});
  const data = await res.json();
  $("adminStatus").innerText = data.message;
  if(data.success) username=newName;
}

async function updateAdminPassword(){
  const newPass = $("newAdminPass").value.trim();
  if(!newPass){ $("adminStatus").innerText="Enter new password"; return; }
  const res = await fetch("/admin/update-password",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({adminUsername:username,newPassword:newPass})});
  const data = await res.json();
  $("adminStatus").innerText = data.message;
  if(data.success) $("newAdminPass").value="";
}

function escapeHtml(s){ if(!s) return ""; return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
