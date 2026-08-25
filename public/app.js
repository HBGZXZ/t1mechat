/* t1Mechat 客户端逻辑 */
"use strict";

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

const EMOJIS = ["😀","😄","😂","🤣","😊","😍","🤔","😎","😭","😅","😉","😴",
  "👍","👏","🙏","💪","🤝","✌️","🎉","🎂","❤️","💔","🔥","✨",
  "🌸","🍀","🌈","☀️","🌙","⭐","☕","🏀","🎮","📚","🧊","🚀"];

/* ---------------- 状态 ---------------- */
let ws = null;
let me = null;                 // {username, nickname, avatarColor}
let friends = [];              // [{username,nickname,avatarColor,online}]
let requests = [];             // [{id,from,to,message,ts,userInfo}]
let chats = {};                // friend -> {last, unread}
let messages = {};             // friend -> [msg]
let groups = [];               // [{id,name,owner,members,avatarColor,createdAt}]
let groupChats = {};           // "g:"+id -> {last, unread}
let grpSelected = new Set();   // 建群时选中的好友
let pendingGroupName = null;   // 刚创建的群名，用于建群后自动打开
let activeTab = "chats";       // chats | contacts
let activeChat = null;         // key: username | "g:"+groupId
let authMode = "login";        // login | register
let authBusy = false;

/* ---------------- 工具 ---------------- */
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function toast(text, kind) {
  const t = $("#toast");
  t.textContent = text;
  t.className = "toast " + (kind || "");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add("hidden"), 2600);
}
function pad(n) { return n < 10 ? "0" + n : "" + n; }
function fmtTime(ts) {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const y = new Date(now.getTime() - 86400000);
  if (d.toDateString() === y.toDateString()) return "昨天";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
function fmtDay(ts) {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return "今天";
  const y = new Date(now.getTime() - 86400000);
  if (d.toDateString() === y.toDateString()) return "昨天";
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}
function friendInfo(username) {
  return friends.find(f => f.username === username) || { username, nickname: username, avatarColor: "#8d96b3", online: false };
}
/* 聊天条目信息：单聊返回好友资料，群聊返回群资料（带 isGroup 标记） */
function chatItemInfo(key) {
  if (key.startsWith("g:")) {
    const g = groups.find(x => x.id === key.slice(2)) || { name: "群聊", avatarColor: "#8d96b3", members: [] };
    return { nickname: g.name, avatarColor: g.avatarColor, online: false, isGroup: true, group: g };
  }
  return { ...friendInfo(key), isGroup: false };
}
function avatarHtml(u, withDot, small) {
  const dot = withDot && u.online ? '<span class="online-dot"></span>' : "";
  const grpCls = u.isGroup ? " group-avatar" : "";
  return `<div class="avatar${small ? " small" : ""}${grpCls}" style="background:linear-gradient(135deg,${u.avatarColor},#ffffff55)">${esc((u.nickname || "?")[0])}${dot}</div>`;
}
function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

/* ---------------- 连接 ---------------- */
function connect() {
  try {
    ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host);
  } catch (e) {
    // file:// 或非法协议下无法建立连接，稍后用户操作时会再提示
    return;
  }
  ws.onopen = () => {
    const saved = localStorage.getItem("t1mechat_creds");
    if (saved) {
      try { send({ type: "login", ...JSON.parse(saved) }); } catch (e) {}
    }
  };
  ws.onmessage = e => {
    let m; try { m = JSON.parse(e.data); } catch (err) { return; }
    handle(m);
  };
  ws.onclose = () => {
    // 掉线自动重连（保持登录态时）
    if (me || localStorage.getItem("t1mechat_creds")) {
      setTimeout(connect, 1600);
    }
  };
}

function handle(m) {
  switch (m.type) {
    case "init":
      me = m.me; friends = m.friends; requests = m.requests;
      chats = {};
      for (const c of m.chats) chats[c.friend] = { last: c.last, unread: c.unread };
      groups = m.groups || [];
      groupChats = {};
      for (const c of (m.groupChats || [])) groupChats["g:" + c.groupId] = { last: c.last, unread: c.unread };
      localStorage.setItem("t1mechat_creds", JSON.stringify({ username: me.username, password: $("#inPassword").value || getCachedPass() }));
      authBusy = false;
      $("#authBtn").disabled = false;
      resetAuthBtnText();
      $("#authView").classList.add("hidden");
      $("#mainView").classList.remove("hidden");
      $("#meAvatar").textContent = me.nickname[0];
      $("#meAvatar").style.background = `linear-gradient(135deg,${me.avatarColor},#ffffff55)`;
      $("#popNickname").textContent = me.nickname;
      $("#popId").textContent = me.username;
      if (activeChat) {
        if (activeChat.startsWith("g:")) {
          if (!groups.some(g => "g:" + g.id === activeChat)) activeChat = null;
        } else if (!friends.some(f => f.username === activeChat)) activeChat = null;
      }
      renderAll();
      break;
    case "error":
      if (!me) {
        $("#authTip").textContent = m.message;
        authBusy = false;
        $("#authBtn").disabled = false;
        resetAuthBtnText();
      }
      toast(m.message, "err");
      break;
    case "ok":
      toast(m.message, "ok");
      break;
    case "message":
      onIncoming(m.msg);
      break;
    case "sent":
      onIncoming(m.msg);
      break;
    case "searchResults":
      renderSearchResults(m.results);
      break;
    case "requests":
      requests = m.requests;
      renderAll();
      break;
    case "friendUpdate":
      friends = m.friends;
      renderAll();
      if (activeChat && !activeChat.startsWith("g:") && !friends.some(f => f.username === activeChat)) closeChat();
      break;
    case "presence": {
      const f = friends.find(x => x.username === m.username);
      if (f) f.online = m.online;
      renderPanel();
      if (activeChat === m.username) renderChatHead();
      break;
    }
    case "groupUpdate": {
      const oldIds = new Set(groups.map(g => g.id));
      groups = m.groups || [];
      renderAll();
      if (pendingGroupName) {
        const newG = groups.find(g => g.name === pendingGroupName && !oldIds.has(g.id));
        if (newG) {
          pendingGroupName = null;
          openChat("g:" + newG.id);
        }
      } else if (activeChat && activeChat.startsWith("g:") && !groups.some(g => "g:" + g.id === activeChat)) closeChat();
      break;
    }
    case "history":
      messages[m.with] = m.messages;
      if (activeChat === m.with) renderMessages();
      break;
  }
}

function getCachedPass() {
  try { return JSON.parse(localStorage.getItem("t1mechat_creds") || "{}").password || ""; } catch (e) { return ""; }
}

/* ---------------- 消息处理 ---------------- */
function onIncoming(msg) {
  let key, store;
  if (msg.groupId) {
    key = "g:" + msg.groupId;
    store = groupChats;
  } else {
    key = msg.from === me.username ? msg.to : msg.from;
    store = chats;
  }
  (messages[key] = messages[key] || []).push(msg);
  const isMine = msg.from === me.username;
  const c = store[key];
  if (c) {
    c.last = msg;
    if (!isMine && activeChat !== key) c.unread++;
  } else {
    store[key] = { last: msg, unread: !isMine && activeChat !== key ? 1 : 0 };
  }
  if (activeChat === key) {
    renderMessages();
    markRead(key);
  }
  renderPanel();
}

function markRead(key) {
  if (key.startsWith("g:")) {
    const c = groupChats[key];
    if (c) c.unread = 0;
    send({ type: "groupMarkRead", groupId: key.slice(2) });
  } else {
    const c = chats[key];
    if (c) c.unread = 0;
    send({ type: "markRead", with: key });
  }
}

/* ---------------- 渲染：整体 ---------------- */
function renderAll() { renderPanel(); renderChatArea(); }

/* ---------------- 渲染：左栏 + 面板 ---------------- */
function totalUnread() {
  return Object.values(chats).reduce((s, c) => s + c.unread, 0)
    + Object.values(groupChats).reduce((s, c) => s + c.unread, 0);
}
function incomingRequests() { return requests.filter(r => r.to === me.username); }
function outgoingRequests() { return requests.filter(r => r.from === me.username); }

function renderRailBadges() {
  const tu = totalUnread();
  const rb = $("#railChatBadge");
  rb.classList.toggle("hidden", tu === 0);
  rb.textContent = tu > 99 ? "99+" : tu;
  const ir = incomingRequests().length;
  const qb = $("#railReqBadge");
  qb.classList.toggle("hidden", ir === 0);
  qb.textContent = ir;
}

function renderPanel() {
  renderRailBadges();
  const panel = $("#panel");
  if (activeTab === "chats") {
    const allChats = [
      ...Object.entries(chats).map(([k, c]) => ({ key: k, ...c, isGroup: false })),
      ...Object.entries(groupChats).map(([k, c]) => ({ key: k, ...c, isGroup: true })),
    ].sort((a, b) => b.last.ts - a.last.ts);
    const list = allChats.map(({ key, last, unread, isGroup }) => {
      const u = chatItemInfo(key);
      const preview = last.from === me.username
        ? `我：${esc(last.text)}`
        : (isGroup ? `${esc(friendInfo(last.from).nickname)}：${esc(last.text)}` : esc(last.text));
      return `<div class="chat-item${activeChat === key ? " active" : ""}" data-chat="${esc(key)}">
          ${avatarHtml(u, !isGroup)}
          <div class="ci-main">
            <div class="ci-top">
              <span class="ci-name">${esc(u.nickname)}</span>
              <span class="ci-time">${fmtTime(last.ts)}</span>
            </div>
            <div class="ci-bottom">
              <span class="ci-preview">${preview}</span>
              ${unread ? `<span class="ci-badge">${unread > 99 ? "99+" : unread}</span>` : ""}
            </div>
          </div>
        </div>`;
    }).join("");
    panel.innerHTML = `
      <div class="panel-head"><span class="panel-title">聊天</span></div>
      <div class="panel-list">${list || '<p class="empty-note">还没有聊天记录<br>去通讯录找朋友聊聊吧</p>'}</div>`;
    $$(".chat-item").forEach(el => el.onclick = () => openChat(el.dataset.chat));
  } else {
    const incoming = incomingRequests();
    const outgoing = outgoingRequests();
    const reqHtml = incoming.map(r => `
      <div class="req-card">
        <div class="req-head">
          ${avatarHtml(r.userInfo || { nickname: "?", avatarColor: "#8d96b3" }, false, true)}
          <div class="req-info">
            <div class="req-name">${esc((r.userInfo || {}).nickname || "未知用户")}</div>
            <div class="req-msg">${esc(r.message)}</div>
          </div>
        </div>
        <div class="req-btns">
          <button class="btn-primary" data-accept="${r.id}">接受</button>
          <button class="btn-ghost" data-decline="${r.id}">拒绝</button>
        </div>
      </div>`).join("");
    const outHtml = outgoing.length ? `
      <div class="sec-title">已发送 · 等待验证</div>
      ${outgoing.map(r => `
        <div class="req-card">
          <div class="req-head">
            ${avatarHtml(r.userInfo || { nickname: "?", avatarColor: "#8d96b3" }, false, true)}
            <div class="req-info">
              <div class="req-name">${esc((r.userInfo || {}).nickname || "")}</div>
              <div class="req-msg">${esc(r.message)}</div>
            </div>
          </div>
          <div class="req-state">等待对方验证</div>
        </div>`).join("")}` : "";
    const sorted = [...friends].sort((a, b) => a.nickname.localeCompare(b.nickname, "zh"));
    const friendHtml = sorted.map(u => `
      <div class="contact-item" data-chat="${esc(u.username)}">
        ${avatarHtml(u, true, true)}
        <div class="co-main">
          <div class="co-name">${esc(u.nickname)}</div>
          <div class="co-status${u.online ? "" : " off"}">${u.online ? "在线" : "离线"}</div>
        </div>
      </div>`).join("");
    const groupHtml = groups.map(g => {
      const u = chatItemInfo("g:" + g.id);
      return `<div class="contact-item" data-chat="${esc("g:" + g.id)}">
        ${avatarHtml({ ...u, online: false }, false, true)}
        <div class="co-main">
          <div class="co-name">${esc(g.name)}</div>
          <div class="co-status off">${(g.members || []).length} 人</div>
        </div>
      </div>`;
    }).join("");
    panel.innerHTML = `
      <div class="panel-head">
        <span class="panel-title">通讯录</span>
        <span class="panel-sub">${friends.length} 位好友</span>
      </div>
      <div class="panel-list">
        <div class="sec-title">新的朋友 ${incoming.length ? `<span class="sec-badge">${incoming.length}</span>` : ""}</div>
        ${reqHtml || '<p class="empty-note" style="padding:8px 0 14px">暂无新的请求</p>'}
        ${outHtml}
        <div class="sec-title">我的群聊 ${groups.length ? `<span class="sec-badge">${groups.length}</span>` : ""}</div>
        ${groupHtml || '<p class="empty-note" style="padding:8px 0 14px">还没有群聊，点左下角群图标创建</p>'}
        <div class="sec-title">好友</div>
        ${friendHtml || '<p class="empty-note">还没有好友，点左下角 + 添加</p>'}
      </div>`;
    $$("[data-accept]").forEach(el => el.onclick = () => send({ type: "respond", id: el.dataset.accept, accept: true }));
    $$("[data-decline]").forEach(el => el.onclick = () => send({ type: "respond", id: el.dataset.decline, accept: false }));
    $$(".contact-item").forEach(el => el.onclick = () => openChat(el.dataset.chat));
  }
}

/* ---------------- 渲染：聊天区 ---------------- */
function closeChat() {
  activeChat = null;
  renderChatArea();
  renderPanel();
}

function openChat(key) {
  activeChat = key;
  activeTab = "chats";
  $("#btnChats").classList.add("active");
  $("#btnContacts").classList.remove("active");
  if (!messages[key]) {
    if (key.startsWith("g:")) send({ type: "groupHistory", groupId: key.slice(2) });
    else send({ type: "history", with: key });
  }
  renderChatArea();
  renderPanel();
  markRead(key);
  const input = $("#msgInput");
  if (input) setTimeout(() => input.focus(), 50);
}

function renderChatHead() {
  const head = $("#chatHead");
  if (!head || !activeChat) return;
  if (activeChat.startsWith("g:")) {
    const g = groups.find(x => x.id === activeChat.slice(2)) || { name: "群聊", members: [] };
    $("#chName").textContent = g.name;
    const m = $("#chStatusText");
    if (m) m.textContent = `${(g.members || []).length} 位成员`;
    return;
  }
  const u = friendInfo(activeChat);
  $("#chName").textContent = u.nickname;
  const st = $("#chStatus");
  if (st) st.className = "ch-status" + (u.online ? "" : " off");
  $("#chStatusText").textContent = u.online ? "在线" : "离线";
}

function renderChatArea() {
  const area = $("#chatArea");
  if (!activeChat) {
    area.innerHTML = `<div class="empty-chat"><div class="empty-bubble"></div><p>选择一个聊天，开始和朋友聊起来</p></div>`;
    return;
  }
  const isGroup = activeChat.startsWith("g:");
  const u = isGroup ? chatItemInfo(activeChat) : friendInfo(activeChat);
  const g = isGroup ? (groups.find(x => x.id === activeChat.slice(2)) || { members: [] }) : null;
  const metaHtml = isGroup
    ? `<div class="ch-group-meta"><span id="chStatusText">${(g.members || []).length} 位成员</span></div>`
    : `<div class="ch-status${u.online ? "" : " off"}" id="chStatus"><span class="s-dot"></span><span id="chStatusText">${u.online ? "在线" : "离线"}</span></div>`;
  area.innerHTML = `
    <div class="chat-head" id="chatHead">
      ${avatarHtml(u, !isGroup, true)}
      <div>
        <div class="ch-name" id="chName">${esc(u.nickname)}</div>
        ${metaHtml}
      </div>
    </div>
    <div class="msg-list" id="msgList"></div>
    <div class="chat-input">
      <div class="ci-toolbar">
        <button class="tool-btn" id="emojiBtn" title="表情">😊</button>
      </div>
      <div class="ci-row">
        <input id="msgInput" maxlength="2000" placeholder="输入消息…">
        <button class="send-btn" id="sendBtn">发送</button>
      </div>
      <div class="emoji-panel hidden" id="emojiPanel"></div>
    </div>`;
  renderMessages();
  bindChatInput();
}

function renderMessages() {
  const box = $("#msgList");
  if (!box) return;
  const list = messages[activeChat] || [];
  const isGroup = activeChat.startsWith("g:");
  let html = "";
  let lastDay = "";
  for (const m of list) {
    const day = new Date(m.ts).toDateString();
    if (day !== lastDay) {
      html += `<div class="day-sep"><span>${fmtDay(m.ts)}</span></div>`;
      lastDay = day;
    }
    const mine = m.from === me.username;
    const u = mine ? me : friendInfo(m.from);
    const sender = isGroup && !mine ? `<div class="msg-sender">${esc(u.nickname)}</div>` : "";
    html += `<div class="msg-row${mine ? " right" : ""}">
      <div class="avatar small" style="background:linear-gradient(135deg,${u.avatarColor},#ffffff55)">${esc((u.nickname || "?")[0])}</div>
      <div>
        ${sender}
        <div class="bubble">${esc(m.text)}</div>
        <div class="msg-time-tip">${fmtTime(m.ts)}</div>
      </div>
    </div>`;
  }
  box.innerHTML = html || '<p class="empty-note">还没有消息，说点什么吧</p>';
  box.scrollTop = box.scrollHeight;
}

function bindChatInput() {
  const input = $("#msgInput");
  const btn = $("#sendBtn");
  const doSend = () => {
    const text = input.value.trim();
    if (!text || !activeChat) return;
    if (activeChat.startsWith("g:")) send({ type: "groupMessage", to: activeChat.slice(2), text });
    else send({ type: "send", to: activeChat, text });
    input.value = "";
    input.focus();
  };
  btn.onclick = doSend;
  input.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); doSend(); } };

  // 表情面板
  const panel = $("#emojiPanel");
  panel.innerHTML = EMOJIS.map(e2 => `<button data-emoji="${e2}">${e2}</button>`).join("");
  $("#emojiBtn").onclick = e => {
    e.stopPropagation();
    panel.classList.toggle("hidden");
  };
  panel.querySelectorAll("[data-emoji]").forEach(b => b.onclick = () => {
    input.value += b.dataset.emoji;
    input.focus();
  });
}

/* ---------------- 搜索 / 加好友 ---------------- */
let addTarget = null;

function renderSearchResults(results) {
  const box = $("#searchResults");
  const form = $("#addForm");
  form.classList.add("hidden");
  addTarget = null;
  if (!results.length) {
    box.innerHTML = '<p class="search-hint">没有找到符合的人</p>';
    return;
  }
  const relationText = {
    friend: '<span class="r-tag">已是好友</span>',
    pending_out: '<span class="r-tag">等待验证</span>',
    pending_in: '<span class="r-tag">对方请求加你</span>',
    self: '<span class="r-tag">这是你自己</span>',
  };
  box.innerHTML = results.map(r => `
    <div class="result-item">
      <div class="avatar" style="background:linear-gradient(135deg,${r.avatarColor},#ffffff55)">${esc(r.nickname[0])}</div>
      <div class="r-info">
        <div class="r-name">${esc(r.nickname)}</div>
        <div class="r-id">t1Mechat 号：${esc(r.username)}</div>
      </div>
      ${relationText[r.relation] || `<button class="btn-primary small" data-add="${esc(r.username)}" data-nick="${esc(r.nickname)}">添加</button>`}
    </div>`).join("");
  box.querySelectorAll("[data-add]").forEach(b => b.onclick = () => {
    addTarget = b.dataset.add;
    $("#addTargetName").textContent = `${b.dataset.nick}（${b.dataset.add}）`;
    $("#addForm").classList.remove("hidden");
    $("#addMessage").focus();
  });
}

function doSearch() {
  const q = $("#searchInput").value.trim();
  if (!q) return;
  $("#searchResults").innerHTML = '<p class="search-hint">搜索中…</p>';
  send({ type: "search", q });
}

/* ---------------- 建群 ---------------- */
function openCreateGroupModal() {
  grpSelected = new Set();
  $("#grpName").value = "";
  const list = $("#grpMemberList");
  if (!friends.length) {
    list.innerHTML = '<p class="grp-empty">还没有好友，先去添加好友吧</p>';
  } else {
    list.innerHTML = [...friends].sort((a, b) => a.nickname.localeCompare(b.nickname, "zh"))
      .map(f => `
      <div class="grp-member-item" data-gm="${esc(f.username)}">
        ${avatarHtml(f, false, true)}
        <div style="flex:1;min-width:0">
          <div class="gm-name">${esc(f.nickname)}</div>
          <div class="gm-id">${esc(f.username)}</div>
        </div>
        <span class="gm-check"></span>
      </div>`).join("");
    list.querySelectorAll("[data-gm]").forEach(el => el.onclick = () => {
      const u = el.dataset.gm;
      if (grpSelected.has(u)) { grpSelected.delete(u); el.classList.remove("selected"); }
      else { grpSelected.add(u); el.classList.add("selected"); }
      $("#grpCount").textContent = grpSelected.size;
    });
  }
  $("#grpCount").textContent = "0";
  $("#modalCreateGroup").classList.remove("hidden");
  setTimeout(() => $("#grpName").focus(), 50);
}

function doCreateGroup() {
  const name = $("#grpName").value.trim();
  const members = [...grpSelected];
  if (!name) { toast("请填写群名称", "err"); return; }
  if (members.length < 1) { toast("至少选择 1 位好友", "err"); return; }
  pendingGroupName = name;
  send({ type: "createGroup", name, members });
  $("#modalCreateGroup").classList.add("hidden");
}

/* ---------------- 登录 / 注册 UI ---------------- */
function authBtnText() { return authMode === "login" ? "登录" : "注册并登录"; }
function resetAuthBtnText() { $("#authBtn").textContent = authBtnText(); }
function setAuthBtnBusy() { $("#authBtn").textContent = authMode === "login" ? "登录中…" : "注册中…"; }
function wsReady() { return !!(ws && ws.readyState === 1); }

function setAuthMode(mode) {
  authMode = mode;
  $("#tabLogin").classList.toggle("active", mode === "login");
  $("#tabReg").classList.toggle("active", mode === "register");
  $("#fieldNick").classList.toggle("hidden", mode !== "register");
  $("#authBtn").textContent = authBtnText();
  $("#authTip").textContent = "";
}

function doAuth() {
  if (authBusy) return;
  const username = $("#inUsername").value.trim();
  const password = $("#inPassword").value;
  if (!username || !password) { $("#authTip").textContent = "请填写完整"; return; }
  if (!wsReady()) {
    // 服务器未连接：不要傻等 6 秒，直接提示并尝试重连
    $("#authTip").textContent = "无法连接服务器，请稍后重试…";
    connect();
    return;
  }
  authBusy = true;
  $("#authBtn").disabled = true;
  setAuthBtnBusy();
  const payload = { type: authMode === "login" ? "login" : "register", username, password };
  if (authMode === "register") payload.nickname = $("#regNick").value.trim() || username;
  send(payload);
  // init 成功时会重置 authBusy；超时兜底并给出明确提示
  setTimeout(() => {
    if (authBusy) {
      authBusy = false;
      $("#authBtn").disabled = false;
      resetAuthBtnText();
      $("#authTip").textContent = "服务器响应超时，请稍后重试";
    }
  }, 6000);
}

/* ---------------- 事件绑定 ---------------- */
function bind() {
  $("#tabLogin").onclick = () => setAuthMode("login");
  $("#tabReg").onclick = () => setAuthMode("register");
  $("#authBtn").onclick = doAuth;
  $("#inPassword").onkeydown = e => { if (e.key === "Enter") doAuth(); };

  $("#btnChats").onclick = () => {
    activeTab = "chats";
    $("#btnChats").classList.add("active");
    $("#btnContacts").classList.remove("active");
    renderPanel();
  };
  $("#btnContacts").onclick = () => {
    activeTab = "contacts";
    $("#btnContacts").classList.add("active");
    $("#btnChats").classList.remove("active");
    renderPanel();
  };
  $("#btnAdd").onclick = () => {
    $("#modalAdd").classList.remove("hidden");
    $("#addForm").classList.add("hidden");
    $("#searchInput").value = "";
    $("#searchResults").innerHTML = '<p class="search-hint">输入 t1Mechat 号或昵称搜索</p>';
    setTimeout(() => $("#searchInput").focus(), 50);
  };
  $("#modalClose").onclick = () => $("#modalAdd").classList.add("hidden");
  $("#modalAdd").onclick = e => { if (e.target === $("#modalAdd")) $("#modalAdd").classList.add("hidden"); };
  // 发起群聊
  $("#btnCreateGroup").onclick = openCreateGroupModal;
  $("#grpClose").onclick = () => $("#modalCreateGroup").classList.add("hidden");
  $("#modalCreateGroup").onclick = e => { if (e.target === $("#modalCreateGroup")) $("#modalCreateGroup").classList.add("hidden"); };
  $("#grpCreate").onclick = doCreateGroup;
  $("#grpName").onkeydown = e => { if (e.key === "Enter") doCreateGroup(); };
  $("#searchBtn").onclick = doSearch;
  $("#searchInput").onkeydown = e => { if (e.key === "Enter") doSearch(); };
  $("#addConfirm").onclick = () => {
    if (!addTarget) return;
    send({ type: "addFriend", to: addTarget, message: $("#addMessage").value.trim() });
    $("#modalAdd").classList.add("hidden");
  };

  $("#meAvatar").onclick = e => {
    e.stopPropagation();
    $("#profilePop").classList.toggle("hidden");
  };
  document.addEventListener("click", e => {
    if (!$("#profilePop").contains(e.target) && e.target !== $("#meAvatar")) {
      $("#profilePop").classList.add("hidden");
    }
  });
  $("#copyId").onclick = () => {
    navigator.clipboard && navigator.clipboard.writeText(me.username);
    toast("已复制：" + me.username, "ok");
  };
  $("#logoutBtn").onclick = () => {
    localStorage.removeItem("t1mechat_creds");
    location.reload();
  };
  // 表情面板点击外部关闭（只绑定一次，动态查找当前面板）
  document.addEventListener("click", e => {
    const panel = $("#emojiPanel");
    if (panel && !panel.classList.contains("hidden") &&
        !panel.contains(e.target) && e.target !== $("#emojiBtn")) {
      panel.classList.add("hidden");
    }
  });
}

/* ---------------- 启动 ---------------- */
bind();
connect();
