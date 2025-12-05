let ws = null;
let adminUsername = null;

const $ = id => document.getElementById(id);

function escapeHtml(s){ if(!s) return ""; return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

// ---------------- LOGIN ----------------
$("loginBtn").onclick = async () => {
  const u = $("loginUser").value.trim();
  const p = $("loginPass").value.trim();
  if(!u||!p){ $("loginMessage").innerText="Enter username & password"; return; }

  const res = await fetch("/login", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({username:u,password:p})
  });
  const data = await res.json();

  if(!data.success){ $("loginMessage").innerText=data.message; return; }
  if(!data.admin){ $("loginMessage").innerText="Use admin login"; return; }

  adminUsername = data.username;
  $("loginArea").style.display="none";
  $("adminArea").style.display="block";

  startWebSocket();
  loadAdminMessages();
  loadUsersList();
};

// ---------------- WEBSOCKET ----------------
function startWebSocket() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}`);
  ws.onopen = ()=>ws.send(JSON.stringify({type:"setAdmin"}));
  ws.onmessage = e => {
    try {
      const data = JSON.parse(e.data);
      if(data.type==="userList") renderUsersTable(data.users);
      else if(data.type==="chat") loadAdminMessages();
    } catch(err) { console.error("ws parse", err); }
  };
  ws.onerror = (ev) => console.error("ws error", ev);
}

// ---------------- MESSAGES ----------------
async function loadAdminMessages() {
  const res = await fetch("/admin/messages");
  const data = await res.json();
  const tbody = $("msgHistoryBody");
  tbody.innerHTML = "";
  if(data.success){
    data.messages.forEach(m=>{
      const tr = document.createElement("tr");
      // server stores time as epoch seconds in messages.time
      tr.innerHTML = `<td>${escapeHtml(m.username)}</td><td>${escapeHtml(m.message)}</td><td>${new Date(m.time*1000).toLocaleString()}</td>`;
      tbody.appendChild(tr);
    });
  }
}

// ---------------- USERS ----------------
async function loadUsersList() {
  const res = await fetch("/admin/users");
  const data = await res.json();
  if(data.success) renderUsersTable(data.users);
}

function renderUsersTable(users){
  const tbody = $("usersTableBody");
  tbody.innerHTML = "";
  users.forEach(u=>{
    const last = u.lastactive || u.lastActive || u.last_active || u.lastActive; // handle case-insensitive names
    const lastStr = last ? new Date(Number(last)*1000).toLocaleString() : "-";
    const loc = `${u.city||"-"}, ${u.region||"-"}, ${u.country||"-"}`;
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${escapeHtml(u.username)}</td><td>${escapeHtml(lastStr)}</td><td>${escapeHtml(loc)}</td><td><button class="delUserBtn" data-user="${escapeHtml(u.username)}">Delete</button></td>`;
    tbody.appendChild(tr);
  });

  document.querySelectorAll(".delUserBtn").forEach(btn=>{
    btn.onclick = async ()=>{
      if(!confirm(`Delete user ${btn.dataset.user}?`)) return;
      const res = await fetch("/admin/delete-user", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({adminUsername, username: btn.dataset.user})
      });
      const data = await res.json();
      alert(data.message || (data.success ? "Deleted" : "Failed"));
      loadUsersList();
    };
  });
}

// ---------------- DELETE MESSAGES ----------------
$("deleteMessagesBtn").onclick = async ()=>{
  if(!confirm("Delete all messages?")) return;
  const res = await fetch("/admin/delete-messages", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({adminUsername})
  });
  const data = await res.json();
  alert(data.message || (data.success ? "Deleted" : "Failed"));
  loadAdminMessages();
};

$("deleteAllBtn").onclick = async ()=>{
  if(!confirm("Delete messages + logins + non-admin users?")) return;
  const res = await fetch("/admin/delete-all", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({adminUsername})
  });
  const data = await res.json();
  alert(data.message || (data.success ? "Deleted" : "Failed"));
  loadAdminMessages();
  loadUsersList();
};

// ---------------- UPDATE ADMIN ----------------
$("updateAdmNameBtn").onclick = async ()=>{
  const newName = $("newAdminName").value.trim();
  if(!newName){ $("adminStatus").innerText="Enter new username"; return; }
  const res = await fetch("/admin/update-username", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({adminUsername, newUsername:newName})
  });
  const data = await res.json();
  $("adminStatus").innerText = data.message;
  if(data.success) adminUsername=newName;
};

$("updateAdmPassBtn").onclick = async ()=>{
  const newPass = $("newAdminPass").value.trim();
  if(!newPass){ $("adminStatus").innerText="Enter new password"; return; }
  const res = await fetch("/admin/update-password", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({adminUsername, newPassword:newPass})
  });
  const data = await res.json();
  $("adminStatus").innerText = data.message;
  if(data.success) $("newAdminPass").value="";
};
