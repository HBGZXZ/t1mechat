/* ============================================================
 * t1Mechat 后端服务
 *  - WebSocket 实时通信（登录/注册/聊天/好友/在线状态）
 *  - 静态文件托管（public 目录），同端口 HTTP + WS
 *  - 数据持久化到 server/data/db.json
 *
 * 启动：npm start  或  node server.js
 * 访问：http://localhost:3000
 * ============================================================ */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = process.env.PORT || 3000;
const STATIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const HISTORY_LIMIT = 200;   // 单聊最多拉取的历史消息条数
const MSG_MAX = 2000;        // 单条消息最大长度
const REQ_MAX = 50;          // 好友请求附言最大长度

const AVATAR_COLORS = [
  "#5b5bd6", "#e05b5b", "#3a9d6b", "#c9781f", "#8f5bd6",
  "#1f9dc9", "#d65b8f", "#5b9d3a", "#b85bd6", "#d69b1f",
];

/* ---------------- 数据存储 ---------------- */
let db = { users: {}, friends: {}, requests: [], readUntil: {}, messages: {}, groups: {}, groupMessages: {}, groupReadUntil: {} };

function loadDb() {
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    db.users = db.users || {};
    db.friends = db.friends || {};
    db.requests = db.requests || [];
    db.readUntil = db.readUntil || {};
    db.messages = db.messages || {};
    db.groups = db.groups || {};
    db.groupMessages = db.groupMessages || {};
    db.groupReadUntil = db.groupReadUntil || {};
  } catch (e) {
    db = { users: {}, friends: {}, requests: [], readUntil: {}, messages: {}, groups: {}, groupMessages: {}, groupReadUntil: {} };
  }
}
function saveDb() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error("保存数据失败:", e.message);
  }
}
loadDb();

/* ---------------- 工具函数 ---------------- */
function hashPass(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString("hex");
}
function avatarFor(username) {
  let h = 0;
  for (const ch of username) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function userInfo(u) {
  return { username: u.username, nickname: u.nickname, avatarColor: u.avatarColor };
}
function msgKey(a, b) {
  return [a, b].sort().join("|");
}
function isFriend(a, b) {
  return !!(db.friends[a] && db.friends[a].includes(b));
}
function isOnline(username) {
  return conns.has(username);
}
function pushTo(username, obj) {
  const ws = conns.get(username);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}
function err(ws, message) {
  ws.send(JSON.stringify({ type: "error", message }));
}

/* 推送某用户的完整请求列表（含发起人信息） */
function pushRequests(username) {
  const list = db.requests
    .filter(r => r.from === username || r.to === username)
    .map(r => ({ ...r, userInfo: userInfo(db.users[r.from]) }));
  pushTo(username, { type: "requests", requests: list });
}

/* 推送某用户的最新好友列表（含在线状态） */
function pushFriendUpdate(username) {
  const friends = (db.friends[username] || []).map(f => ({
    ...userInfo(db.users[f]),
    online: isOnline(f),
  }));
  pushTo(username, { type: "friendUpdate", friends });
}

/* 某用户加入的所有群（精简信息，含成员资料） */
function groupsOf(username) {
  return Object.values(db.groups)
    .filter(g => g.members.includes(username))
    .map(g => ({
      id: g.id, name: g.name, owner: g.owner,
      avatarColor: g.avatarColor, createdAt: g.createdAt,
      members: g.members.map(m => ({ ...userInfo(db.users[m]), online: isOnline(m) })),
    }));
}

/* 推送某用户的群组列表 */
function pushGroupUpdate(username) {
  pushTo(username, { type: "groupUpdate", groups: groupsOf(username) });
}

/* 发送登录初始化数据 */
function sendInit(ws, username) {
  const me = userInfo(db.users[username]);
  const friends = (db.friends[username] || []).map(f => ({
    ...userInfo(db.users[f]),
    online: isOnline(f),
  }));
  const requests = db.requests
    .filter(r => r.from === username || r.to === username)
    .map(r => ({ ...r, userInfo: userInfo(db.users[r.from]) }));
  const chats = [];
  for (const f of db.friends[username] || []) {
    const list = db.messages[msgKey(username, f)] || [];
    if (!list.length) continue;
    const last = list[list.length - 1];
    const readT = (db.readUntil[username] || {})[f] || 0;
    const unread = list.filter(m => m.from === f && m.ts > readT).length;
    chats.push({ friend: f, last, unread });
  }
  // 群聊摘要
  const groupChats = [];
  for (const g of Object.values(db.groups)) {
    if (!g.members.includes(username)) continue;
    const list = db.groupMessages[g.id] || [];
    if (!list.length) continue;
    const last = list[list.length - 1];
    const readT = (db.groupReadUntil[username] || {})[g.id] || 0;
    const unread = list.filter(m => m.from !== username && m.ts > readT).length;
    groupChats.push({ groupId: g.id, name: g.name, last, unread });
  }
  const groups = groupsOf(username);
  ws.send(JSON.stringify({ type: "init", me, friends, requests, chats, groups, groupChats }));
}

/* 登录/注册成功后绑定连接 */
function bindUser(ws, username) {
  const old = conns.get(username);
  if (old && old !== ws) {
    try { old.send(JSON.stringify({ type: "error", message: "你的账号已在其他设备登录，本连接已断开" })); } catch (e) {}
    try { old.close(4001, "logged in elsewhere"); } catch (e) {}
  }
  ws.user = username;
  conns.set(username, ws);
  // 通知好友：我上线了
  for (const f of db.friends[username] || []) {
    pushTo(f, { type: "presence", username, online: true });
  }
  sendInit(ws, username);
  pushTo(username, { type: "ok", message: "登录成功，欢迎回来" });
}

/* ---------------- WebSocket 消息处理 ---------------- */
function handleMsg(ws, msg) {
  switch (msg.type) {

    case "register": {
      const username = String(msg.username || "").trim();
      const password = String(msg.password || "");
      if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
        return err(ws, "账号需为 3-20 位字母/数字/下划线");
      }
      if (password.length < 4) {
        return err(ws, "密码至少 4 位");
      }
      if (db.users[username]) {
        return err(ws, "该账号已注册，请直接登录");
      }
      let nickname = String(msg.nickname || "").trim().slice(0, 12) || username;
      const salt = crypto.randomBytes(8).toString("hex");
      db.users[username] = {
        username,
        nickname,
        salt,
        passhash: hashPass(password, salt),
        avatarColor: avatarFor(username),
      };
      db.friends[username] = [];
      saveDb();
      console.log(`[注册] ${username}（${nickname}）`);
      bindUser(ws, username);
      break;
    }

    case "login": {
      const username = String(msg.username || "").trim();
      const password = String(msg.password || "");
      const u = db.users[username];
      if (!u) return err(ws, "账号不存在，请先注册");
      if (hashPass(password, u.salt) !== u.passhash) return err(ws, "密码错误");
      console.log(`[登录] ${username}`);
      bindUser(ws, username);
      break;
    }

    case "send": {
      if (!ws.user) return err(ws, "请先登录");
      const text = String(msg.text || "").trim().slice(0, MSG_MAX);
      if (!text) return;
      const to = String(msg.to || "");
      if (!db.users[to]) return err(ws, "对方不存在");
      if (!isFriend(ws.user, to)) return err(ws, "对方还不是你的好友");
      const m = { from: ws.user, to, text, ts: Date.now() };
      (db.messages[msgKey(ws.user, to)] = db.messages[msgKey(ws.user, to)] || []).push(m);
      saveDb();
      pushTo(to, { type: "message", msg: m });      // 发给接收者
      ws.send(JSON.stringify({ type: "sent", msg: m })); // 回执给发送者
      break;
    }

    case "markRead": {
      if (!ws.user) return;
      const f = String(msg.with || "");
      const list = db.messages[msgKey(ws.user, f)] || [];
      const last = list[list.length - 1];
      if (!last) return;
      db.readUntil[ws.user] = db.readUntil[ws.user] || {};
      db.readUntil[ws.user][f] = last.ts;
      saveDb();
      break;
    }

    case "history": {
      if (!ws.user) return;
      const f = String(msg.with || "");
      const list = (db.messages[msgKey(ws.user, f)] || []).slice(-HISTORY_LIMIT);
      ws.send(JSON.stringify({ type: "history", with: f, messages: list }));
      break;
    }

    case "search": {
      if (!ws.user) return;
      const q = String(msg.q || "").trim().toLowerCase();
      if (!q) return ws.send(JSON.stringify({ type: "searchResults", results: [] }));
      const results = [];
      for (const u of Object.values(db.users)) {
        if (u.username === ws.user) continue;
        if (u.username.toLowerCase().includes(q) || u.nickname.toLowerCase().includes(q)) {
          results.push({ ...userInfo(u), relation: relationOf(ws.user, u.username) });
          if (results.length >= 20) break;
        }
      }
      ws.send(JSON.stringify({ type: "searchResults", results }));
      break;
    }

    case "addFriend": {
      if (!ws.user) return err(ws, "请先登录");
      const to = String(msg.to || "");
      if (!db.users[to]) return err(ws, "用户不存在");
      if (to === ws.user) return err(ws, "不能添加自己为好友");
      if (isFriend(ws.user, to)) return err(ws, "你们已经是好友了");
      if (db.requests.some(r => r.from === ws.user && r.to === to)) {
        return err(ws, "已发送过请求，等待对方验证");
      }
      const req = {
        id: crypto.randomBytes(8).toString("hex"),
        from: ws.user,
        to,
        message: String(msg.message || "").trim().slice(0, REQ_MAX),
        ts: Date.now(),
      };
      db.requests.push(req);
      saveDb();
      console.log(`[好友请求] ${ws.user} -> ${to}`);
      pushRequests(ws.user);
      pushRequests(to);
      pushTo(to, { type: "ok", message: "你收到一条新的好友请求" });
      break;
    }

    case "respond": {
      if (!ws.user) return err(ws, "请先登录");
      const req = db.requests.find(r => r.id === String(msg.id || ""));
      if (!req) return err(ws, "请求不存在或已处理");
      if (req.to !== ws.user) return err(ws, "无权处理该请求");
      db.requests = db.requests.filter(r => r.id !== req.id);
      if (msg.accept) {
        if (!isFriend(req.from, req.to)) {
          db.friends[req.from].push(req.to);
          db.friends[req.to].push(req.from);
        }
        saveDb();
        console.log(`[成为好友] ${req.from} <-> ${req.to}`);
        pushFriendUpdate(req.from);
        pushFriendUpdate(req.to);
        // 同步彼此在线状态（成为好友瞬间可能已有连接）
        if (isOnline(req.to)) pushTo(req.from, { type: "presence", username: req.to, online: true });
        if (isOnline(req.from)) pushTo(req.to, { type: "presence", username: req.from, online: true });
        pushTo(req.from, { type: "ok", message: "对方已接受你的好友请求" });
        pushTo(req.to, { type: "ok", message: "添加好友成功" });
      } else {
        saveDb();
        pushTo(req.from, { type: "ok", message: "对方拒绝了你的好友请求" });
        pushTo(req.to, { type: "ok", message: "已拒绝该请求" });
      }
      pushRequests(req.from);
      pushRequests(req.to);
      break;
    }

    /* ---------------- 群聊 ---------------- */
    case "createGroup": {
      if (!ws.user) return err(ws, "请先登录");
      const name = String(msg.name || "").trim().slice(0, 20) || "未命名群聊";
      const picked = Array.isArray(msg.members) ? msg.members.filter(m => db.users[m] && isFriend(ws.user, m)) : [];
      const members = Array.from(new Set([ws.user, ...picked])).slice(0, 100);
      if (members.length < 2) return err(ws, "至少选择 1 位好友建群");
      const gid = "g" + crypto.randomBytes(8).toString("hex");
      db.groups[gid] = { id: gid, name, owner: ws.user, members, avatarColor: avatarFor(gid), createdAt: Date.now() };
      db.groupMessages[gid] = [];
      saveDb();
      console.log(`[建群] ${ws.user} 创建「${name}」(${members.length}人)`);
      for (const m of members) {
        pushGroupUpdate(m);
        pushTo(m, { type: "ok", message: m === ws.user ? `群聊「${name}」已创建` : `你被邀请加入群聊「${name}」` });
      }
      break;
    }

    case "inviteGroup": {
      if (!ws.user) return err(ws, "请先登录");
      const gid = String(msg.groupId || "");
      const g = db.groups[gid];
      if (!g) return err(ws, "群聊不存在");
      if (!g.members.includes(ws.user)) return err(ws, "你不在该群聊中");
      const invited = Array.isArray(msg.members) ? msg.members.filter(m => db.users[m] && isFriend(ws.user, m) && !g.members.includes(m)) : [];
      if (!invited.length) return err(ws, "没有可邀请的好友");
      g.members.push(...invited);
      saveDb();
      console.log(`[邀请入群] ${ws.user} 邀请 ${invited.join(",")} 加入 ${gid}`);
      for (const m of g.members) {
        pushGroupUpdate(m);
        if (invited.includes(m)) pushTo(m, { type: "ok", message: `你被邀请加入群聊「${g.name}」` });
      }
      break;
    }

    case "groupMessage": {
      if (!ws.user) return err(ws, "请先登录");
      const gid = String(msg.to || "");
      const g = db.groups[gid];
      if (!g) return err(ws, "群聊不存在");
      if (!g.members.includes(ws.user)) return err(ws, "你不在该群聊中");
      const text = String(msg.text || "").trim().slice(0, MSG_MAX);
      if (!text) return;
      const m = { groupId: gid, from: ws.user, text, ts: Date.now() };
      (db.groupMessages[gid] = db.groupMessages[gid] || []).push(m);
      if (db.groupMessages[gid].length > HISTORY_LIMIT) db.groupMessages[gid] = db.groupMessages[gid].slice(-HISTORY_LIMIT);
      saveDb();
      for (const member of g.members) {
        if (member === ws.user) ws.send(JSON.stringify({ type: "sent", msg: m }));
        else pushTo(member, { type: "message", msg: m });
      }
      break;
    }

    case "groupHistory": {
      if (!ws.user) return;
      const gid = String(msg.groupId || "");
      const g = db.groups[gid];
      if (!g || !g.members.includes(ws.user)) return err(ws, "无权查看该群聊");
      const list = (db.groupMessages[gid] || []).slice(-HISTORY_LIMIT);
      ws.send(JSON.stringify({ type: "history", with: "g:" + gid, messages: list }));
      break;
    }

    case "groupMarkRead": {
      if (!ws.user) return;
      const gid = String(msg.groupId || "");
      const list = db.groupMessages[gid] || [];
      const last = list[list.length - 1];
      if (!last) return;
      db.groupReadUntil[ws.user] = db.groupReadUntil[ws.user] || {};
      db.groupReadUntil[ws.user][gid] = last.ts;
      saveDb();
      break;
    }

    case "leaveGroup": {
      if (!ws.user) return err(ws, "请先登录");
      const gid = String(msg.groupId || "");
      const g = db.groups[gid];
      if (!g) return err(ws, "群聊不存在");
      if (!g.members.includes(ws.user)) return err(ws, "你不在该群聊中");
      g.members = g.members.filter(m => m !== ws.user);
      if (g.members.length <= 0) {
        delete db.groups[gid];
        delete db.groupMessages[gid];
      }
      saveDb();
      console.log(`[退群] ${ws.user} 退出 ${gid}`);
      pushGroupUpdate(ws.user);
      for (const m of g.members || []) pushGroupUpdate(m);
      pushTo(ws.user, { type: "ok", message: "已退出群聊" });
      break;
    }

    default:
      break;
  }
}

function relationOf(a, b) {
  if (isFriend(a, b)) return "friend";
  const req = db.requests.find(r => (r.from === a && r.to === b) || (r.from === b && r.to === a));
  if (req) return req.from === a ? "pending_out" : "pending_in";
  return "none";
}

/* ---------------- HTTP 静态托管 ---------------- */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split("?")[0]);
  } catch (e) {
    urlPath = req.url.split("?")[0];
  }
  if (urlPath.endsWith("/")) urlPath += "index.html";
  const fp = path.normalize(path.join(STATIC_DIR, urlPath));
  if (!fp.startsWith(STATIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(fp, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404 Not Found");
      return;
    }
    const ext = path.extname(fp).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

/* ---------------- 服务启动 ---------------- */
const conns = new Map(); // username -> WebSocket

const server = http.createServer((req, res) => serveStatic(req, res));

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
});

wss.on("connection", ws => {
  ws.user = null;

  ws.on("message", data => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (e) { return; }
    if (!msg || typeof msg !== "object") return;
    try { handleMsg(ws, msg); } catch (e) {
      console.error("处理消息出错:", e);
      err(ws, "服务器内部错误");
    }
  });

  ws.on("close", () => {
    if (ws.user && conns.get(ws.user) === ws) {
      conns.delete(ws.user);
      // 通知好友：我下线了
      for (const f of db.friends[ws.user] || []) {
        pushTo(f, { type: "presence", username: ws.user, online: false });
      }
      console.log(`[离线] ${ws.user}`);
    }
  });

  ws.on("error", () => { /* 忽略连接级错误 */ });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("======================================");
  console.log("  t1Mechat 服务已启动");
  console.log(`  页面访问 : http://localhost:${PORT}`);
  console.log(`  聊天数据 : ${DB_FILE}`);
  console.log("======================================");
});
