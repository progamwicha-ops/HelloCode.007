// =========================================================
// HelloCode - Kahoot Monitor, Live Battle Pro (Firestore Cloud Real-Time + WebRTC Fallback) & Dino AI Assistant
// Module loaded after js/c-simulator.js and before js/app.js
// =========================================================

// =========================================================
// PART 1: REAL-TIME KAHOOT ROOM DISCOVERY & TEACHER LIVE MONITOR
// =========================================================
const KAHOOT_STALE_ROOM_MS = 3 * 60 * 60 * 1000; // Auto-filter stale rooms older than 3 hours
let kahootBroadcastChannel = null;
let kahootMonitorSyncBound = false;
let kCloudRoomsCache = {};
let kUnsubRoomsMonitor = null;
let kMonitorPlayerUnsubs = {};

function isKahootCloudMode() {
  return Boolean(
    typeof DataService !== 'undefined' &&
    DataService.Cloud &&
    typeof DataService.Cloud.isCloudActive === 'function' &&
    DataService.Cloud.isCloudActive() &&
    DataService.Cloud._db
  );
}

function getKahootFirestoreDb() {
  return isKahootCloudMode() ? DataService.Cloud._db : null;
}

function isKahootRoomStale(room) {
  if (!room) return true;
  const now = Date.now();
  if (typeof room.expiresAt === 'number' && room.expiresAt > 0 && now > room.expiresAt) {
    return true;
  }
  const refTs = Number(room.createdAt || 0);
  if (refTs > 0 && (now - refTs) > KAHOOT_STALE_ROOM_MS) {
    return true;
  }
  return false;
}

function loadActiveKahootSessions() {
  // Cloud as Single Source of Truth: never union localStorage when Firebase Cloud is active
  if (isKahootCloudMode()) {
    const filtered = {};
    Object.keys(kCloudRoomsCache).forEach(pinKey => {
      const room = kCloudRoomsCache[pinKey];
      if (room && !isKahootRoomStale(room)) {
        filtered[pinKey] = room;
      }
    });
    return filtered;
  }
  try {
    const raw = safeStorage.getItem("c_edu_active_kahoot_sessions_v4");
    const parsed = raw ? JSON.parse(raw) : {};
    const filtered = {};
    Object.keys(parsed || {}).forEach(k => {
      if (parsed[k] && !isKahootRoomStale(parsed[k])) {
        filtered[k] = parsed[k];
      }
    });
    return filtered;
  } catch (e) {
    return {};
  }
}

function saveActiveKahootSessions(sessions) {
  if (isKahootCloudMode()) return;
  safeStorage.setItem("c_edu_active_kahoot_sessions_v4", JSON.stringify(sessions || {}));
  if (kahootBroadcastChannel) {
    try { kahootBroadcastChannel.postMessage({ type: 'KAHOOT_MONITOR_SYNC' }); } catch (e) {}
  }
}

function clearMonitorPlayerListeners(exceptPinsSet = null) {
  Object.keys(kMonitorPlayerUnsubs).forEach(pinKey => {
    if (exceptPinsSet && exceptPinsSet.has(pinKey)) return;
    try {
      if (typeof kMonitorPlayerUnsubs[pinKey] === 'function') kMonitorPlayerUnsubs[pinKey]();
    } catch (e) {}
    delete kMonitorPlayerUnsubs[pinKey];
  });
}

function syncTeacherMonitorPlayerListeners() {
  const db = getKahootFirestoreDb();
  if (!db) return;
  const activePins = new Set(Object.keys(kCloudRoomsCache));
  clearMonitorPlayerListeners(activePins);

  activePins.forEach(pinKey => {
    if (kMonitorPlayerUnsubs[pinKey]) return;
    kMonitorPlayerUnsubs[pinKey] = db.collection("kahoot_rooms")
      .doc(pinKey)
      .collection("players")
      .onSnapshot((snap) => {
        if (!kCloudRoomsCache[pinKey]) return;
        const playersMap = {};
        snap.forEach(doc => {
          const d = doc.data() || {};
          playersMap[doc.id] = {
            id: doc.id,
            uid: d.uid || doc.id,
            name: d.name || "ผู้เรียน",
            year: d.year || "-",
            score: Number(d.score || 0),
            streak: Number(d.streak || 0),
            answered: Boolean(d.answered),
            rank: Number(d.rank || 0),
            isBot: Boolean(d.isBot),
            online: d.online !== false
          };
        });
        kCloudRoomsCache[pinKey].players = playersMap;
        kCloudRoomsCache[pinKey].playerCount = Object.keys(playersMap).length;
        if (typeof renderLiveKahootHomeBanner === 'function') renderLiveKahootHomeBanner();
        const tSec = document.getElementById("teacherSection");
        if (tSec && !tSec.classList.contains("hidden")) {
          renderTeacherKahootMonitor();
        }
        if (typeof updateTeacherKpisAndBadges === 'function') updateTeacherKpisAndBadges();
      }, () => {});
  });
}

function startCloudKahootRoomsMonitor() {
  const db = getKahootFirestoreDb();
  if (!db) return;
  if (typeof kUnsubRoomsMonitor === 'function') {
    try { kUnsubRoomsMonitor(); } catch (e) {}
    kUnsubRoomsMonitor = null;
  }

  kUnsubRoomsMonitor = db.collection("kahoot_rooms")
    .limit(30)
    .onSnapshot((snap) => {
      const nextCache = {};
      snap.forEach(doc => {
        const d = doc.data() || {};
        const createdMs = (typeof toTimestampMs === 'function') ? toTimestampMs(d.createdAt) : Number(d.createdAt || 0);
        const startedMs = (typeof toTimestampMs === 'function') ? toTimestampMs(d.startedAt) : Number(d.startedAt || 0);
        const expiresMs = (typeof toTimestampMs === 'function') ? toTimestampMs(d.expiresAt) : Number(d.expiresAt || 0);
        const prevPlayers = (kCloudRoomsCache[doc.id] && kCloudRoomsCache[doc.id].players) ? kCloudRoomsCache[doc.id].players : {};
        const normalized = {
          fullPin: d.fullPin || doc.id,
          pin: d.pin || doc.id,
          slot: d.slot || String(doc.id).charAt(0) || "1",
          hostUid: d.hostUid || "",
          hostName: d.hostName || "หัวหน้าห้องแข่งขัน",
          unitTitle: d.unitTitle || "รวมทุกหน่วยการเรียนรู้",
          status: d.status || "lobby",
          currentQ: Number(d.currentQ || 0),
          totalQ: Number(d.totalQ || 10),
          timeLimit: Number(d.timeLimit || 15),
          playerCount: Number(d.playerCount || Object.keys(prevPlayers).length || 0),
          createdAt: createdMs || Date.now(),
          startedAt: startedMs || null,
          expiresAt: expiresMs || ((createdMs || Date.now()) + KAHOOT_STALE_ROOM_MS),
          players: prevPlayers
        };
        if (!isKahootRoomStale(normalized)) {
          nextCache[doc.id] = normalized;
        }
      });

      kCloudRoomsCache = nextCache;
      syncTeacherMonitorPlayerListeners();

      if (typeof renderLiveKahootHomeBanner === 'function') renderLiveKahootHomeBanner();
      const tSec = document.getElementById("teacherSection");
      if (tSec && !tSec.classList.contains("hidden")) {
        renderTeacherKahootMonitor();
      }
      if (typeof updateTeacherKpisAndBadges === 'function') updateTeacherKpisAndBadges();
    }, (err) => {
      console.warn("Cloud Kahoot rooms monitor error:", err);
    });
}

function initKahootMonitorSync() {
  if (kahootMonitorSyncBound) return;
  kahootMonitorSyncBound = true;

  if (isKahootCloudMode()) {
    startCloudKahootRoomsMonitor();
    return;
  }

  try {
    if ('BroadcastChannel' in window) {
      kahootBroadcastChannel = new BroadcastChannel('c_edu_kahoot_channel_v4');
      kahootBroadcastChannel.onmessage = (ev) => {
        if (ev.data && ev.data.type === 'KAHOOT_MONITOR_SYNC') {
          if (typeof renderLiveKahootHomeBanner === 'function') renderLiveKahootHomeBanner();
          const tSec = document.getElementById("teacherSection");
          if (tSec && !tSec.classList.contains("hidden")) {
            renderTeacherKahootMonitor();
          }
        }
      };
    }
  } catch (e) {}

  window.addEventListener('storage', (ev) => {
    if (ev.key === 'c_edu_active_kahoot_sessions_v4' || ev.key === 'c_edu_db_users_v4') {
      if (typeof renderLiveKahootHomeBanner === 'function') renderLiveKahootHomeBanner();
      const tSec = document.getElementById("teacherSection");
      if (tSec && !tSec.classList.contains("hidden")) {
        renderTeacherKahootMonitor();
        if (typeof renderTeacherReportTable === 'function') renderTeacherReportTable();
      }
    }
  });
}

function formatDurationMinutes(startMs) {
  if (!startMs) return "ยังไม่เริ่มจับเวลา";
  const diffSec = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
  const mins = Math.floor(diffSec / 60);
  const secs = diffSec % 60;
  return `${mins} นาที ${secs < 10 ? '0' + secs : secs} วินาที`;
}

function renderTeacherKahootMonitor() {
  const container = document.getElementById("teacherKahootMonitorContainer");
  const badge = document.getElementById("teacherActiveRoomsBadge");
  if (!container) return;

  const sessions = loadActiveKahootSessions();
  const roomKeys = Object.keys(sessions).sort((a, b) => (sessions[b].createdAt || 0) - (sessions[a].createdAt || 0));

  if (badge) badge.innerText = `${roomKeys.length} ห้อง`;
  if (typeof updateTeacherKpisAndBadges === 'function') updateTeacherKpisAndBadges();

  if (roomKeys.length === 0) {
    container.innerHTML = `
      <div style="background:rgba(255,255,255,0.08); border:1px dashed rgba(255,255,255,0.25); border-radius:14px; padding:18px; text-align:center; color:#CBD5E1; font-size:0.88rem;">
        ${getSymbolIcon('radio', 18, 'color:#A5B4FC;')} ขณะนี้ยังไม่มีห้องแข่งขัน Kahoot ที่เปิดอยู่
      </div>
    `;
    return;
  }

  let html = "";
  roomKeys.forEach(pinKey => {
    const room = sessions[pinKey];
    const playersArr = Object.values(room.players || {}).sort((a, b) => (b.score || 0) - (a.score || 0));
    const displayPlayerCount = Math.max(playersArr.length, Number(room.playerCount || 0));
    const statusMap = {
      'lobby': `${getSymbolIcon('circleFilled', 12, 'color:#FACC15;')} กำลังรอผู้เล่นเข้าห้อง`,
      'playing': `${getSymbolIcon('circleFilled', 12, 'color:#4ADE80;')} กำลังแข่งขันสด · ข้อ ${room.currentQ || 1}/${room.totalQ || 10}`,
      'leaderboard': `${getSymbolIcon('circleFilled', 12, 'color:#38BDF8;')} สรุปคะแนนรอบข้อ ${room.currentQ || 1}/${room.totalQ || 10}`,
      'finished': `${getSymbolIcon('flag', 13, 'color:#CBD5E1;')} จบการแข่งขันแล้ว`
    };
    const elapsedStr = room.startedAt ? formatDurationMinutes(room.startedAt) : `เปิดห้องเมื่อ ${formatDurationMinutes(room.createdAt)}`;

    let playerRows = "";
    if (playersArr.length === 0) {
      playerRows = `<div style="color:#CBD5E1; font-size:0.82rem; padding:8px;">ยังไม่มีผู้เล่นเข้าร่วมในห้องนี้...</div>`;
    } else {
      playerRows = `
        <div class="table-scroll-wrap kahoot-monitor-table-wrap">
          <table class="kahoot-monitor-table">
            <thead>
              <tr style="background:rgba(255,255,255,0.1); color:#A5B4FC;">
                <th style="padding:6px;">อันดับ</th>
                <th style="padding:6px; text-align:left;">ชื่อนักเรียนที่กำลังเล่น</th>
                <th style="padding:6px;">ชั้นปี</th>
                <th style="padding:6px;">สถานะข้อนี้</th>
                <th style="padding:6px;">Streak</th>
                <th style="padding:6px; text-align:right;">คะแนนปัจจุบัน</th>
              </tr>
            </thead>
            <tbody>
              ${playersArr.map((p, i) => `
                <tr style="border-bottom:1px solid rgba(255,255,255,0.07);">
                  <td style="padding:6px; font-weight:800; color:${i===0?'#FDE047':i===1?'#E2E8F0':i===2?'#FDBA74':'#94A3B8'};">#${i + 1}</td>
                  <td style="padding:6px; text-align:left; font-weight:700;">${getSymbolIcon('user', 13)} ${escapeHTML(p.name)}</td>
                  <td style="padding:6px;">${escapeHTML(p.year || '-')}</td>
                  <td style="padding:6px;">${p.answered ? `<span style="color:#4ADE80;">${getSymbolIcon('checkCircle', 13)} ตอบแล้ว</span>` : `<span style="color:#FCD34D;">${getSymbolIcon('clock', 13)} กำลังคิด</span>`}</td>
                  <td style="padding:6px;">${p.streak > 0 ? `${getSymbolIcon('flame', 13, 'color:#FB923C;')} x` + Number(p.streak) : '-'}</td>
                  <td style="padding:6px; text-align:right; font-weight:800; color:#38BDF8;">${Number(p.score || 0).toLocaleString()} คะแนน</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    }

    html += `
      <div class="kahoot-room-card">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
          <div>
            <span style="background:#4F46E5; color:white; padding:3px 10px; border-radius:8px; font-weight:800; font-size:0.85rem; margin-right:6px;">
              PIN: ${escapeHTML(room.fullPin)}
            </span>
            <strong style="font-size:0.98rem; color:#F8FAFC;">หัวหน้าห้อง: ${escapeHTML(room.hostName || 'นักเรียน/ครู')}</strong>
            <span style="font-size:0.8rem; color:#C7D2FE; margin-left:6px;">· ${escapeHTML(room.unitTitle || 'รวมทุกหน่วย')}</span>
          </div>
          <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
            <span style="font-size:0.82rem; background:rgba(16,185,129,0.2); color:#6EE7B7; padding:3px 10px; border-radius:99px; font-weight:700;">
              ${getSymbolIcon('clock', 13)} เวลาที่เล่น: ${escapeHTML(elapsedStr)}
            </span>
            <span style="font-size:0.82rem; background:rgba(255,255,255,0.14); color:#FDE047; padding:3px 10px; border-radius:99px; font-weight:700;">
              ${getSymbolIcon('users', 13)} ผู้เล่น: ${displayPlayerCount} / ${KAHOOT_MAX_PLAYERS} คน
            </span>
            <button class="btn btn-danger" style="min-height:26px; padding:2px 8px; font-size:0.72rem;" onclick="removeKahootSession('${escapeHTML(pinKey)}')">${getSymbolIcon('x', 12)} ปิดห้อง</button>
          </div>
        </div>
        <div style="font-size:0.82rem; color:#A5B4FC; margin-top:6px; font-weight:600;">
          สถานะ: ${statusMap[room.status] || escapeHTML(room.status)}
        </div>
        ${playerRows}
      </div>
    `;
  });

  container.innerHTML = html;
}

async function deleteCloudKahootRoomDoc(pinKey) {
  const db = getKahootFirestoreDb();
  if (!db || !pinKey) return;
  const roomRef = db.collection("kahoot_rooms").doc(pinKey);
  try {
    const pSnap = await roomRef.collection("players").get();
    if (!pSnap.empty) {
      const docs = pSnap.docs;
      for (let i = 0; i < docs.length; i += 400) {
        const batch = db.batch();
        docs.slice(i, i + 400).forEach(d => batch.delete(d.ref));
        await batch.commit();
      }
    }
  } catch (e) {}
  await roomRef.delete().catch(() => {});
}

async function removeKahootSession(pinKey) {
  if (isKahootCloudMode()) {
    try {
      await deleteCloudKahootRoomDoc(pinKey);
      showToast(`ปิดห้อง Kahoot PIN ${pinKey} บน Cloud เรียบร้อยแล้ว`, "info");
    } catch (err) {
      showToast(`ปิดห้องไม่สำเร็จ: ${err.message || err}`, "error");
    }
    return;
  }
  const sessions = loadActiveKahootSessions();
  delete sessions[pinKey];
  saveActiveKahootSessions(sessions);
  renderTeacherKahootMonitor();
}

async function clearFinishedKahootSessions() {
  if (isKahootCloudMode()) {
    const pinsToClear = Object.keys(kCloudRoomsCache).filter(k => {
      const r = kCloudRoomsCache[k];
      return !r || r.status === 'finished' || isKahootRoomStale(r);
    });
    await Promise.all(pinsToClear.map(pin => deleteCloudKahootRoomDoc(pin)));
    showToast(`ล้างห้องที่จบแล้ว ${pinsToClear.length} ห้องเรียบร้อยแล้ว`, "info");
    return;
  }
  const sessions = loadActiveKahootSessions();
  Object.keys(sessions).forEach(k => {
    if (sessions[k].status === 'finished') delete sessions[k];
  });
  saveActiveKahootSessions(sessions);
  renderTeacherKahootMonitor();
}

async function simulateLiveKahootForTeacher() {
  const simPin = "1" + Math.floor(1000 + Math.random() * 9000);
  const mockPlayers = {
    "p1": { name: "สมชาย มุ่งมั่นโค้ด", year: "ปวช.3", score: 3420, streak: 4, answered: true, isBot: true },
    "p2": { name: "ขวัญ นภาลัย", year: "ปวช.2", score: 3180, streak: 3, answered: true, isBot: true },
    "p3": { name: "ปิยะพัฒน์ สายสร้าง", year: "ปวส.1", score: 2650, streak: 2, answered: true, isBot: true },
    "p4": { name: "อนันดา พัฒนาการ", year: "ปวช.1", score: 1940, streak: 1, answered: false, isBot: true },
    "p5": { name: "ณัฐกานต์ โปรแกรมเมอร์", year: "ปวส.2", score: 2890, streak: 2, answered: true, isBot: true },
    "p6": { name: "กิตติพงศ์ ไอที", year: "ปวช.2", score: 1520, streak: 0, answered: false, isBot: true }
  };

  if (isKahootCloudMode()) {
    if (!currentUser || !currentUser.isLoggedIn || !currentUser.uid) {
      showToast("กรุณาเข้าสู่ระบบครูผู้สอนก่อนจำลองห้องบน Cloud", "warning");
      return;
    }
    const db = getKahootFirestoreDb();
    const now = Date.now();
    try {
      const roomRef = db.collection("kahoot_rooms").doc(simPin);
      await roomRef.set({
        fullPin: simPin,
        pin: simPin,
        slot: "1",
        hostUid: currentUser.uid,
        hostName: "ขวัญ นภาลัย (ห้องจำลอง Cloud)",
        unitTitle: "รวมทุกหน่วยการเรียนรู้ (1-5)",
        status: "playing",
        currentQ: 4,
        totalQ: 10,
        timeLimit: 15,
        playerCount: Object.keys(mockPlayers).length,
        createdAt: now - 240000,
        startedAt: now - 195000,
        expiresAt: now + KAHOOT_STALE_ROOM_MS,
        updatedAt: window.HelloCodeFirebase.serverTimestamp()
      });
      const batch = db.batch();
      Object.entries(mockPlayers).forEach(([pid, p]) => {
        batch.set(roomRef.collection("players").doc(pid), {
          uid: pid,
          ...p,
          online: true,
          joinedAt: now - 220000
        });
      });
      await batch.commit();
      playSfx('success');
      showToast(`สร้างห้องจำลอง PIN ${simPin} บน Firestore Cloud แล้ว`, "success");
    } catch (err) {
      showToast(`สร้างห้องจำลองไม่สำเร็จ: ${err.message || err}`, "error");
    }
    return;
  }

  const sessions = loadActiveKahootSessions();
  sessions[simPin] = {
    fullPin: simPin,
    slot: "1",
    hostName: "ขวัญ นภาลัย (หัวหน้ากลุ่ม)",
    unitTitle: "รวมทุกหน่วยการเรียนรู้ (1-5)",
    status: "playing",
    currentQ: 4,
    totalQ: 10,
    createdAt: Date.now() - 240000,
    startedAt: Date.now() - 195000,
    players: mockPlayers
  };
  saveActiveKahootSessions(sessions);
  renderTeacherKahootMonitor();
  playSfx('success');
}

// =========================================================
// PART 2: KAHOOT LIVE BATTLE PRO (FIRESTORE CLOUD PRIMARY + WEBRTC FALLBACK)
// =========================================================
function stopCloudPlayerListeners() {
  if (typeof kUnsubPlayerRoom === 'function') {
    try { kUnsubPlayerRoom(); } catch (e) {}
    kUnsubPlayerRoom = null;
  }
  if (typeof kUnsubPlayerSelf === 'function') {
    try { kUnsubPlayerSelf(); } catch (e) {}
    kUnsubPlayerSelf = null;
  }
  clearInterval(kPlayerTimerInt);
}

function stopCloudHostListeners() {
  if (typeof kUnsubHostPlayers === 'function') {
    try { kUnsubHostPlayers(); } catch (e) {}
    kUnsubHostPlayers = null;
  }
}

function kSwitchView(viewName) {
  const views = ['kViewRoleSelect', 'kViewHostConfig', 'kViewJoinPin', 'kViewHostLobby', 'kViewHostLive', 'kViewHostLeaderboard', 'kViewPlayerScreen'];
  views.forEach(v => {
    const el = document.getElementById(v);
    if (el) el.classList.add("hidden");
  });
  if (viewName === 'roleSelect') {
    stopCloudPlayerListeners();
    document.getElementById('kViewRoleSelect').classList.remove('hidden');
  } else if (viewName === 'hostConfig') document.getElementById('kViewHostConfig').classList.remove('hidden');
  else if (viewName === 'joinPin') document.getElementById('kViewJoinPin').classList.remove('hidden');
  else if (viewName === 'hostLobby') document.getElementById('kViewHostLobby').classList.remove('hidden');
  else if (viewName === 'hostLive') document.getElementById('kViewHostLive').classList.remove('hidden');
  else if (viewName === 'hostLeaderboard') document.getElementById('kViewHostLeaderboard').classList.remove('hidden');
  else if (viewName === 'playerScreen') document.getElementById('kViewPlayerScreen').classList.remove('hidden');
  if (typeof syncAiDockZIndex === 'function') syncAiDockZIndex();
}

// WebRTC STUN / TURN CONFIGURATION (Used in Local Demo Fallback Mode)
const KAHOOT_MAX_PLAYERS = 40;
const peerConfig = {
  pingInterval: 5000,
  config: {
    iceTransportPolicy: 'all',
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' }
    ]
  }
};

let peer = null;
let hostConnections = [];
let playerConn = null;
let kHostPin = "";
let kHostSlot = "1";
let kFullRoomPin = "";
let kHostPlayers = {};
let kQuestionsPool = [];
let kCurrentQIdx = 0;
let kTimePerQuestion = 15;
let kHostTimerInt = null;
let kHostTimeLeft = 15;
let kHostGameStartTime = null;
let kHostCreatedAt = null;
let kHostUnitTitle = "";
let kHostPhase = "idle"; // 'idle' | 'lobby' | 'playing' | 'leaderboard' | 'finished'
let kPlayerTimerInt = null;
let kPlayerTimeLeft = 15;
let kPlayerAnswered = false;

// Cloud Real-Time Kahoot Listener State
let kUnsubHostPlayers = null;
let kUnsubPlayerRoom = null;
let kUnsubPlayerSelf = null;
let kPlayerLastQIdx = -1;
let kPlayerFeedbackShownForQ = -1;
let kPlayerRoomStatus = "lobby";
let kPlayerTotalPlayers = 1;
let kHostGradingInFlight = new Set();

// Stability, Heartbeat, Auto-Reconnect & Answer Queue State (Local WebRTC Fallback)
let kHostHeartbeatInt = null;
let kPlayerHeartbeatInt = null;
let kPlayerReconnectTimer = null;
let kPlayerReconnectAttempts = 0;
let kPlayerLeftIntentionally = false;
let kActiveJoinPinRaw = "";
let kAnswerQueue = [];
let kQueueDrainScheduled = false;
let kMonitorSyncTimer = null;
let kLastPingRttMs = null;

function getOrCreateKahootSessionId() {
  try {
    let sid = sessionStorage.getItem("c_edu_kahoot_player_sid");
    if (!sid) {
      sid = "ks_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
      sessionStorage.setItem("c_edu_kahoot_player_sid", sid);
    }
    return sid;
  } catch (e) {
    return "ks_" + Math.random().toString(36).slice(2, 10);
  }
}

function setHostConnectionBadge(state, label) {
  ["hostConnStatusBadge", "hostLiveConnStatusBadge"].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = `kahoot-conn-pill ${state}`;
    el.innerHTML = `<span class="kahoot-conn-dot"></span> ${escapeHTML(label)}`;
  });
}

function setPlayerConnectionBadge(state, label) {
  const el = document.getElementById("playerConnStatusBadge");
  if (!el) return;
  el.className = `kahoot-conn-pill ${state}`;
  el.innerHTML = `<span class="kahoot-conn-dot"></span> ${escapeHTML(label)}`;
}

function syncHostRoomToTeacherMonitor(statusStr) {
  if (!kFullRoomPin) return;
  if (isKahootCloudMode()) return; // Firestore room doc is synced directly by Host actions
  const sessions = loadActiveKahootSessions();
  sessions[kFullRoomPin] = {
    fullPin: kFullRoomPin,
    slot: kHostSlot,
    hostName: (currentUser && currentUser.isLoggedIn) ? currentUser.name : "หัวหน้าห้องแข่งขัน",
    unitTitle: kHostUnitTitle,
    status: statusStr,
    currentQ: kCurrentQIdx + 1,
    totalQ: kQuestionsPool.length,
    createdAt: kHostCreatedAt,
    startedAt: kHostGameStartTime,
    players: kHostPlayers
  };
  saveActiveKahootSessions(sessions);
}

function scheduleThrottledMonitorSync(statusStr = 'playing') {
  if (kMonitorSyncTimer) return;
  kMonitorSyncTimer = setTimeout(() => {
    kMonitorSyncTimer = null;
    updateHostLiveAnsweredCounter();
    syncHostRoomToTeacherMonitor(statusStr);
  }, 240);
}

function stopHostHeartbeat() {
  clearInterval(kHostHeartbeatInt);
  kHostHeartbeatInt = null;
}

function startHostHeartbeat() {
  stopHostHeartbeat();
  kHostHeartbeatInt = setInterval(() => {
    const now = Date.now();
    let onlineCount = 0;
    hostConnections = hostConnections.filter(c => c && c.open);
    hostConnections.forEach(c => {
      try {
        c.send({ type: 'HEARTBEAT_PING', ts: now });
        onlineCount++;
      } catch (e) {}
    });
    const totalCount = Object.keys(kHostPlayers).length;
    setHostConnectionBadge(
      'online',
      `Online · เชื่อมต่อ ${onlineCount} อุปกรณ์ (รวม ${totalCount}/${KAHOOT_MAX_PLAYERS})`
    );
  }, 4000);
}

async function closeHostRoomAndBack() {
  clearInterval(kHostTimerInt);
  stopHostHeartbeat();
  stopCloudHostListeners();
  clearTimeout(kMonitorSyncTimer);
  kMonitorSyncTimer = null;
  kAnswerQueue = [];
  kHostGradingInFlight.clear();
  kHostPhase = "idle";

  const closingPin = kFullRoomPin;
  kFullRoomPin = "";

  if (closingPin) {
    if (isKahootCloudMode()) {
      await deleteCloudKahootRoomDoc(closingPin);
    } else {
      const sessions = loadActiveKahootSessions();
      delete sessions[closingPin];
      saveActiveKahootSessions(sessions);
    }
  }
  if (peer && !peer.destroyed) {
    try { peer.destroy(); } catch (e) {}
  }
  kSwitchView('roleSelect');
}

function findPlayerByPeerOrSession(peerId, sessionId) {
  if (sessionId) {
    for (const [key, p] of Object.entries(kHostPlayers)) {
      if (p && p.sessionId === sessionId) return { key, player: p };
    }
  }
  if (peerId && kHostPlayers[peerId]) {
    return { key: peerId, player: kHostPlayers[peerId] };
  }
  return null;
}

function gradeCloudPlayerAnswer(playerId, playerData) {
  const db = getKahootFirestoreDb();
  if (!db || !kFullRoomPin || kHostPhase !== 'playing') return;
  const curQ = kQuestionsPool[kCurrentQIdx];
  if (!curQ) return;
  const flightKey = `${kCurrentQIdx}:${playerId}`;
  if (kHostGradingInFlight.has(flightKey)) return;
  kHostGradingInFlight.add(flightKey);

  const isCorrect = (Number(playerData.submittedChoice) === curQ.ans);
  let nextStreak = Number(playerData.streak || 0);
  let nextScore = Number(playerData.score || 0);
  let points = 0;

  if (isCorrect) {
    nextStreak += 1;
    const streakBonus = Math.min(300, (nextStreak - 1) * 100);
    const safeTimeLeft = Math.max(0, Math.min(kTimePerQuestion, Number(playerData.submittedTimeLeft || kHostTimeLeft || 0)));
    points = 500 + Math.round((safeTimeLeft / Math.max(1, kTimePerQuestion)) * 500) + streakBonus;
    nextScore += points;
  } else {
    nextStreak = 0;
  }

  if (kHostPlayers[playerId]) {
    kHostPlayers[playerId].answered = true;
    kHostPlayers[playerId].score = nextScore;
    kHostPlayers[playerId].streak = nextStreak;
    kHostPlayers[playerId].gradedQIdx = kCurrentQIdx;
  }
  updateHostLiveAnsweredCounter();

  db.collection("kahoot_rooms")
    .doc(kFullRoomPin)
    .collection("players")
    .doc(playerId)
    .update({
      score: nextScore,
      streak: nextStreak,
      answered: true,
      gradedQIdx: kCurrentQIdx,
      lastCorrect: isCorrect,
      lastPoints: points,
      updatedAt: window.HelloCodeFirebase.serverTimestamp()
    })
    .catch((err) => {
      console.warn("Host cloud grade write error:", err);
      kHostGradingInFlight.delete(flightKey);
    });
}

async function initHostRoom() {
  try {
    kHostSlot = document.getElementById("kConfigSlot").value;
    const unitSelect = document.getElementById("kConfigUnit");
    const selectedUnit = unitSelect.value;
    kHostUnitTitle = unitSelect.options[unitSelect.selectedIndex].text;
    const count = parseInt(document.getElementById("kConfigCount").value, 10);
    kTimePerQuestion = parseInt(document.getElementById("kConfigTime").value, 10);

    let bank = [];
    if (selectedUnit === 'all') {
      for (let u = 1; u <= 5; u++) bank.push(...fullQuestionBank[u]);
    } else {
      bank = [...fullQuestionBank[parseInt(selectedUnit, 10)]];
    }

    kQuestionsPool = bank.sort(() => Math.random() - 0.5).slice(0, count).map(item => {
      const correctText = item.opts[item.ans];
      const shuffledOpts = [...item.opts].sort(() => Math.random() - 0.5);
      return {
        q: item.q,
        opts: shuffledOpts,
        ans: shuffledOpts.indexOf(correctText)
      };
    });

    kHostPin = Math.floor(1000 + Math.random() * 9000).toString();
    kFullRoomPin = `${kHostSlot}${kHostPin}`;
    kHostCreatedAt = Date.now();
    kHostGameStartTime = null;
    kAnswerQueue = [];
    kHostGradingInFlight.clear();
    kHostPlayers = {};
    hostConnections = [];
    kHostPhase = "lobby";

    // === CLOUD MODE: FIRESTORE REAL-TIME KAHOOT ENGINE (Zero WebRTC NAT failure!) ===
    if (isKahootCloudMode()) {
      if (!currentUser || !currentUser.isLoggedIn || !currentUser.uid) {
        showToast("กรุณาเข้าสู่ระบบก่อนสร้างห้องแข่งขัน Kahoot บน Cloud", "warning");
        if (typeof openLoginModal === 'function') openLoginModal();
        return;
      }

      const db = getKahootFirestoreDb();
      // Avoid PIN collision with active non-stale room
      for (let attempt = 0; attempt < 5; attempt++) {
        const snap = await db.collection("kahoot_rooms").doc(kFullRoomPin).get();
        if (!snap.exists || isKahootRoomStale(snap.data()) || snap.data().status === 'finished') {
          break;
        }
        kHostPin = Math.floor(1000 + Math.random() * 9000).toString();
        kFullRoomPin = `${kHostSlot}${kHostPin}`;
      }

      document.getElementById("hostSlotTitleDisplay").innerHTML = `${getSymbolIcon('crown', 18, 'color:#FDE047;')} ห้องแข่งขัน Cloud ช่องที่ ${escapeHTML(kHostSlot)} (${escapeHTML(kHostUnitTitle)})`;
      document.getElementById("hostPinDisplay").innerText = kFullRoomPin;
      document.getElementById("btnHostStart").disabled = true;

      kSwitchView('hostLobby');
      setHostConnectionBadge('reconnecting', 'กำลังสร้างห้อง Cloud Real-Time...');

      const roomRef = db.collection("kahoot_rooms").doc(kFullRoomPin);
      await roomRef.set({
        fullPin: kFullRoomPin,
        pin: kFullRoomPin,
        slot: kHostSlot,
        hostUid: currentUser.uid,
        hostName: currentUser.name || "หัวหน้าห้องแข่งขัน",
        unitTitle: kHostUnitTitle,
        status: "lobby",
        currentQ: 0,
        totalQ: kQuestionsPool.length,
        timeLimit: kTimePerQuestion,
        playerCount: 0,
        questionData: null,
        roundResult: null,
        createdAt: kHostCreatedAt,
        startedAt: null,
        expiresAt: kHostCreatedAt + KAHOOT_STALE_ROOM_MS,
        updatedAt: window.HelloCodeFirebase.serverTimestamp()
      });

      stopCloudHostListeners();
      kUnsubHostPlayers = roomRef.collection("players").onSnapshot((snap) => {
        const nextPlayers = {};
        snap.forEach(doc => {
          const d = doc.data() || {};
          nextPlayers[doc.id] = {
            id: doc.id,
            uid: d.uid || doc.id,
            sessionId: doc.id,
            name: String(d.name || "ผู้เรียน").slice(0, 40),
            year: String(d.year || "ปวช.1").slice(0, 20),
            score: Number(d.score || 0),
            streak: Number(d.streak || 0),
            answered: Boolean(d.answered),
            submittedQIdx: typeof d.submittedQIdx === 'number' ? d.submittedQIdx : -1,
            submittedChoice: (d.submittedChoice !== undefined && d.submittedChoice !== null) ? Number(d.submittedChoice) : null,
            submittedTimeLeft: Number(d.submittedTimeLeft || 0),
            gradedQIdx: typeof d.gradedQIdx === 'number' ? d.gradedQIdx : -1,
            rank: Number(d.rank || 0),
            online: d.online !== false,
            isBot: Boolean(d.isBot)
          };
        });
        kHostPlayers = nextPlayers;
        const totalP = Object.keys(kHostPlayers).length;
        setHostConnectionBadge('online', `Cloud Real-Time · ผู้เล่น ${totalP}/${KAHOOT_MAX_PLAYERS}`);
        updateHostLobbyUI();
        updateHostLiveAnsweredCounter();

        // Authoritative Host grading of incoming player answers for current question
        if (kHostPhase === 'playing') {
          Object.entries(kHostPlayers).forEach(([pid, p]) => {
            if (
              p.submittedQIdx === kCurrentQIdx &&
              p.submittedChoice !== null &&
              p.gradedQIdx !== kCurrentQIdx
            ) {
              gradeCloudPlayerAnswer(pid, p);
            }
          });
        }
      }, (err) => {
        setHostConnectionBadge('reconnecting', `Cloud ซิงก์ขัดข้อง: ${err.code || 'network'}`);
      });

      setHostConnectionBadge('online', `Cloud Real-Time · พร้อมเชื่อมต่อ (0/${KAHOOT_MAX_PLAYERS})`);
      showToast(`สร้างห้อง Kahoot Cloud PIN ${kFullRoomPin} สำเร็จ! นักเรียนเข้าร่วมได้จากทุกอุปกรณ์`, "success");
      return;
    }

    // === LOCAL DEMO FALLBACK: PeerJS WebRTC ===
    document.getElementById("hostSlotTitleDisplay").innerHTML = `${getSymbolIcon('crown', 18, 'color:#FDE047;')} ห้องแข่งขันช่องสัญญาณที่ ${escapeHTML(kHostSlot)} (${escapeHTML(kHostUnitTitle)})`;
    document.getElementById("hostPinDisplay").innerText = kFullRoomPin;
    document.getElementById("btnHostStart").disabled = true;

    kSwitchView('hostLobby');
    setHostConnectionBadge('reconnecting', 'กำลังเปิดช่องสัญญาณ WebRTC...');
    syncHostRoomToTeacherMonitor('lobby');

    const peerId = `c-edu-cprog-kahoot-s${kHostSlot}-${kHostPin}`;
    if (typeof Peer === 'undefined') {
      setHostConnectionBadge('offline', 'ไม่พบไลบรารี PeerJS (ต้องเชื่อมต่ออินเทอร์เน็ต)');
      showToast("ยังโหลดไลบรารี WebRTC (PeerJS) ไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่", "error");
      return;
    }
    if (peer && !peer.destroyed) peer.destroy();
    peer = new Peer(peerId, peerConfig);

    peer.on('open', () => {
      document.getElementById("hostPinDisplay").innerText = kFullRoomPin;
      setHostConnectionBadge('online', `พร้อมเชื่อมต่อ (0/${KAHOOT_MAX_PLAYERS})`);
      startHostHeartbeat();
    });

    peer.on('disconnected', () => {
      setHostConnectionBadge('reconnecting', 'กำลังกู้คืนสัญญาณ Host...');
      try { if (peer && !peer.destroyed) peer.reconnect(); } catch (e) {}
    });

    peer.on('error', (err) => {
      if (err.type === 'unavailable-id') {
        initHostRoom();
        return;
      }
      setHostConnectionBadge('reconnecting', `สัญญาณขัดข้อง (${err.type || 'network'})`);
      showToast(`คำเตือนการเชื่อมต่อ Kahoot Host: ${err.type || err.message}`, "warning");
    });

    peer.on('connection', (conn) => {
      const registerConn = () => {
        hostConnections = hostConnections.filter(c => c && c.peer !== conn.peer);
        hostConnections.push(conn);
      };
      if (conn.open) registerConn();
      else conn.on('open', registerConn);

      conn.on('data', (data) => {
        if (!data || typeof data !== 'object') return;
        registerConn();

        if (data.type === 'HEARTBEAT_PONG') {
          const found = findPlayerByPeerOrSession(conn.peer, data.sessionId);
          if (found) {
            found.player.online = true;
            found.player.lastSeen = Date.now();
          }
          return;
        }

        if (data.type === 'HEARTBEAT_PING') {
          try { conn.send({ type: 'HEARTBEAT_PONG', ts: data.ts }); } catch (e) {}
          return;
        }

        if (data.type === 'JOIN' || data.type === 'REJOIN') {
          const existing = findPlayerByPeerOrSession(conn.peer, data.sessionId);
          if (existing) {
            const prev = existing.player;
            if (existing.key !== conn.peer) {
              delete kHostPlayers[existing.key];
            }
            prev.peerId = conn.peer;
            prev.online = true;
            prev.lastSeen = Date.now();
            kHostPlayers[conn.peer] = prev;
            updateHostLobbyUI();
            scheduleThrottledMonitorSync(kHostGameStartTime ? 'playing' : 'lobby');
            conn.send({
              type: 'JOIN_SUCCESS',
              pin: kHostPin,
              reconnected: true,
              score: prev.score,
              streak: prev.streak,
              inLiveGame: Boolean(kHostGameStartTime && !document.getElementById("kViewHostLive").classList.contains("hidden")),
              timeLeft: kHostTimeLeft,
              answered: prev.answered
            });
            return;
          }

          if (Object.keys(kHostPlayers).length >= KAHOOT_MAX_PLAYERS) {
            conn.send({ type: 'ROOM_FULL', maxPlayers: KAHOOT_MAX_PLAYERS });
            return;
          }

          kHostPlayers[conn.peer] = {
            sessionId: data.sessionId || conn.peer,
            peerId: conn.peer,
            name: String(data.name || "ผู้เรียน").slice(0, 40),
            year: String(data.year || "ปวช.1").slice(0, 20),
            score: 0,
            streak: 0,
            answered: false,
            online: true,
            lastSeen: Date.now(),
            isBot: false
          };
          updateHostLobbyUI();
          syncHostRoomToTeacherMonitor('lobby');
          conn.send({ type: 'JOIN_SUCCESS', pin: kHostPin, reconnected: false });
        } else if (data.type === 'SUBMIT_ANS') {
          enqueuePlayerAnswer(conn.peer, data.choice, data.timeLeft, conn, data.sessionId);
        }
      });

      conn.on('close', () => {
        hostConnections = hostConnections.filter(c => c && c.peer !== conn.peer);
        const p = kHostPlayers[conn.peer];
        if (!p) return;
        p.online = false;
        updateHostLobbyUI();
        scheduleThrottledMonitorSync(kHostGameStartTime ? 'playing' : 'lobby');
      });
    });
  } catch (err) {
    showToast(`ไม่สามารถเปิดห้อง Kahoot ได้: ${err.message || err}`, "error");
  }
}

function enqueuePlayerAnswer(peerKey, choiceIdx, timeLeftVal, connObj, sessionId = null) {
  kAnswerQueue.push({ peerKey, choiceIdx, timeLeftVal, connObj, sessionId });
  if (!kQueueDrainScheduled) {
    kQueueDrainScheduled = true;
    requestAnimationFrame(processAnswerQueue);
  }
}

function processAnswerQueue() {
  kQueueDrainScheduled = false;
  const batchLimit = 25;
  let processed = 0;
  let anyChanged = false;

  while (kAnswerQueue.length > 0 && processed < batchLimit) {
    const item = kAnswerQueue.shift();
    processed++;
    const resolved = findPlayerByPeerOrSession(item.peerKey, item.sessionId);
    const p = resolved ? resolved.player : null;
    if (p && !p.answered) {
      p.answered = true;
      p.online = true;
      p.lastSeen = Date.now();
      const curQ = kQuestionsPool[kCurrentQIdx];
      if (!curQ) continue;
      const isCorrect = (item.choiceIdx === curQ.ans);
      let points = 0;
      if (isCorrect) {
        p.streak = (p.streak || 0) + 1;
        const streakBonus = Math.min(300, (p.streak - 1) * 100);
        const safeTimeLeft = Math.max(0, Math.min(kTimePerQuestion, Number(item.timeLeftVal || 0)));
        points = 500 + Math.round((safeTimeLeft / Math.max(1, kTimePerQuestion)) * 500) + streakBonus;
        p.score += points;
      } else {
        p.streak = 0;
      }
      anyChanged = true;
      if (item.connObj && item.connObj.open) {
        try {
          item.connObj.send({ type: 'ANSWER_FEEDBACK', correct: isCorrect, points: points, totalScore: p.score, streak: p.streak });
        } catch (e) {}
      }
    }
  }

  if (anyChanged) {
    scheduleThrottledMonitorSync('playing');
  }

  if (kAnswerQueue.length > 0 && !kQueueDrainScheduled) {
    kQueueDrainScheduled = true;
    requestAnimationFrame(processAnswerQueue);
  }
}

function handlePlayerAnswerSubmission(peerKey, choiceIdx, timeLeftVal, connObj) {
  enqueuePlayerAnswer(peerKey, choiceIdx, timeLeftVal, connObj);
}

async function addSimulatedBotPlayers(count) {
  const botNames = [
    "กิตติภพ โค้ดไว", "นภัสสร สายซี", "ธนกฤต อัลกอริทึม", "พิมชนก ลูปแม่น", "ศุภณัฐ อาร์เรย์โปร",
    "ชญานิษฐ์ ดีบักเกอร์", "ภูมิพัฒน์ คอมไพเลอร์", "กัญญาณัฐ สตริง", "ธีรภัทร พอยน์เตอร์", "ปุญญิศา ตรรกะเป๊ะ"
  ];
  const years = ["ปวช.1", "ปวช.2", "ปวช.3", "ปวส.1", "ปวส.2"];
  const addedBots = [];

  for (let i = 0; i < count; i++) {
    if (Object.keys(kHostPlayers).length + addedBots.length >= KAHOOT_MAX_PLAYERS) {
      showToast(`ห้องเต็มจำนวนแนะนำสูงสุด ${KAHOOT_MAX_PLAYERS} คนต่อห้องแล้ว`, "warning");
      break;
    }
    const bId = "bot_" + Math.random().toString(36).substring(2, 8);
    const namePick = botNames[Math.floor(Math.random() * botNames.length)] + " #" + Math.floor(10 + Math.random() * 89);
    const botObj = {
      id: bId,
      uid: bId,
      sessionId: bId,
      name: namePick,
      year: years[Math.floor(Math.random() * years.length)],
      score: 0,
      streak: 0,
      answered: false,
      submittedQIdx: -1,
      submittedChoice: null,
      gradedQIdx: -1,
      rank: 0,
      online: true,
      isBot: true
    };
    addedBots.push(botObj);
    if (!isKahootCloudMode()) {
      kHostPlayers[bId] = botObj;
    }
  }

  if (isKahootCloudMode() && kFullRoomPin && addedBots.length > 0) {
    const db = getKahootFirestoreDb();
    try {
      const roomRef = db.collection("kahoot_rooms").doc(kFullRoomPin);
      const batch = db.batch();
      addedBots.forEach(bot => {
        batch.set(roomRef.collection("players").doc(bot.id), {
          ...bot,
          joinedAt: Date.now(),
          updatedAt: window.HelloCodeFirebase.serverTimestamp()
        });
      });
      batch.update(roomRef, {
        playerCount: window.HelloCodeFirebase.increment(addedBots.length),
        updatedAt: window.HelloCodeFirebase.serverTimestamp()
      });
      await batch.commit();
      playSfx('pop');
    } catch (err) {
      showToast(`เพิ่มบอทจำลองบน Cloud ไม่สำเร็จ: ${err.message || err}`, "error");
    }
    return;
  }

  updateHostLobbyUI();
  syncHostRoomToTeacherMonitor('lobby');
  playSfx('pop');
}

function updateHostLobbyUI() {
  const container = document.getElementById("hostPlayerList");
  if (!container) return;
  container.innerHTML = "";
  const pList = Object.values(kHostPlayers);
  document.getElementById("hostPlayerCount").innerText = pList.length;

  pList.forEach(p => {
    const pill = document.createElement("div");
    pill.className = "player-pill";
    const statusDot = p.isBot || p.online !== false
      ? `<span style="width:7px;height:7px;border-radius:50%;background:#10B981;display:inline-block;"></span>`
      : `<span style="width:7px;height:7px;border-radius:50%;background:#F59E0B;display:inline-block;" title="กำลังเชื่อมต่อใหม่"></span>`;
    pill.innerHTML = `${statusDot} ${p.isBot ? getSymbolIcon('cpu', 14) : getSymbolIcon('user', 14)} ${escapeHTML(p.name)} (${escapeHTML(p.year)})`;
    container.appendChild(pill);
  });

  document.getElementById("btnHostStart").disabled = pList.length === 0;
}

function updateHostLiveElapsedUI() {
  const el = document.getElementById("kHostElapsedLive");
  if (el && kHostGameStartTime) {
    const sec = Math.max(0, Math.floor((Date.now() - kHostGameStartTime) / 1000));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    el.innerText = `${m < 10 ? '0' + m : m}:${s < 10 ? '0' + s : s}`;
  }
}

function updateHostLiveAnsweredCounter() {
  const allP = Object.values(kHostPlayers);
  const ansCount = allP.filter(p => p.answered).length;
  const ansEl = document.getElementById("kHostAnsweredCount");
  const totEl = document.getElementById("kHostTotalPlayersLive");
  if (ansEl) ansEl.innerText = ansCount;
  if (totEl) totEl.innerText = allP.length;
}

function startKahootGame() {
  kCurrentQIdx = 0;
  kHostGameStartTime = Date.now();
  kSwitchView('hostLive');
  hostPresentKahootQuestion();
}

async function hostPresentKahootQuestion() {
  clearInterval(kHostTimerInt);
  kAnswerQueue = [];
  kHostGradingInFlight.clear();
  kHostPhase = "playing";
  Object.values(kHostPlayers).forEach(p => {
    p.answered = false;
    p.submittedQIdx = -1;
    p.submittedChoice = null;
    p.gradedQIdx = -1;
  });

  const q = kQuestionsPool[kCurrentQIdx];
  if (!q) {
    hostGoNextQuestion();
    return;
  }
  document.getElementById("kHostQIdx").innerText = kCurrentQIdx + 1;
  document.getElementById("kHostTotalQ").innerText = kQuestionsPool.length;
  document.getElementById("kHostQText").innerText = q.q;

  document.getElementById("kOpt0").innerHTML = `${getSymbolIcon('triangle', 16)} ${escapeHTML(q.opts[0])}`;
  document.getElementById("kOpt1").innerHTML = `${getSymbolIcon('diamond', 16)} ${escapeHTML(q.opts[1])}`;
  document.getElementById("kOpt2").innerHTML = `${getSymbolIcon('circleFilled', 16)} ${escapeHTML(q.opts[2])}`;
  document.getElementById("kOpt3").innerHTML = `${getSymbolIcon('squareFilled', 16)} ${escapeHTML(q.opts[3])}`;

  updateHostLiveAnsweredCounter();
  updateHostLiveElapsedUI();
  kSwitchView('hostLive');

  if (isKahootCloudMode() && kFullRoomPin) {
    const db = getKahootFirestoreDb();
    const roomRef = db.collection("kahoot_rooms").doc(kFullRoomPin);
    try {
      const batch = db.batch();
      Object.keys(kHostPlayers).forEach(pid => {
        batch.update(roomRef.collection("players").doc(pid), {
          answered: false,
          submittedQIdx: -1,
          submittedChoice: null,
          gradedQIdx: -1,
          lastCorrect: null,
          lastPoints: 0
        });
      });
      // Anti-cheat: publish question text & options WITHOUT correct answer index
      batch.update(roomRef, {
        status: "playing",
        currentQ: kCurrentQIdx + 1,
        startedAt: kHostGameStartTime,
        playerCount: Object.keys(kHostPlayers).length,
        questionData: {
          qIdx: kCurrentQIdx,
          qNum: kCurrentQIdx + 1,
          totalQ: kQuestionsPool.length,
          q: q.q,
          opts: q.opts,
          timeLimit: kTimePerQuestion,
          startedAtMs: Date.now()
        },
        roundResult: null,
        updatedAt: window.HelloCodeFirebase.serverTimestamp()
      });
      await batch.commit();
    } catch (err) {
      console.warn("Host cloud presentQuestion error:", err);
    }
  } else {
    syncHostRoomToTeacherMonitor('playing');
    broadcastKahoot({
      type: 'NEW_QUESTION',
      qIdx: kCurrentQIdx + 1,
      totalQ: kQuestionsPool.length,
      timeLimit: kTimePerQuestion
    });
  }

  // Trigger simulated bots cleanly (works in both Cloud & Local Demo modes)
  const activeQIdx = kCurrentQIdx;
  Object.keys(kHostPlayers).forEach(pKey => {
    const p = kHostPlayers[pKey];
    if (p && p.isBot) {
      const delayMs = Math.floor(1500 + Math.random() * (kTimePerQuestion * 750));
      setTimeout(() => {
        if (
          kHostPhase === 'playing' &&
          kCurrentQIdx === activeQIdx &&
          !document.getElementById("kViewHostLive").classList.contains("hidden") &&
          kHostPlayers[pKey] &&
          !kHostPlayers[pKey].answered
        ) {
          const isBotSmart = Math.random() < 0.72;
          const botChoice = isBotSmart ? q.ans : Math.floor(Math.random() * 4);
          if (isKahootCloudMode()) {
            gradeCloudPlayerAnswer(pKey, {
              ...kHostPlayers[pKey],
              submittedQIdx: activeQIdx,
              submittedChoice: botChoice,
              submittedTimeLeft: kHostTimeLeft
            });
          } else {
            enqueuePlayerAnswer(pKey, botChoice, kHostTimeLeft, null, p.sessionId);
          }
        }
      }, delayMs);
    }
  });

  kHostTimeLeft = kTimePerQuestion;
  document.getElementById("kHostTimer").innerText = kHostTimeLeft;
  kHostTimerInt = setInterval(() => {
    kHostTimeLeft--;
    document.getElementById("kHostTimer").innerText = kHostTimeLeft;
    const allP = Object.values(kHostPlayers);
    const allAnswered = allP.length > 0 && allP.every(p => p.answered);
    if (kHostTimeLeft <= 0 || allAnswered) {
      clearInterval(kHostTimerInt);
      hostShowRoundLeaderboard();
    }
  }, 1000);
}

async function hostShowRoundLeaderboard() {
  clearInterval(kHostTimerInt);
  kHostPhase = "leaderboard";
  kSwitchView('hostLeaderboard');
  document.getElementById("kRoundNumDisplay").innerText = kCurrentQIdx + 1;
  const curQ = kQuestionsPool[kCurrentQIdx];
  document.getElementById("kRoundCorrectAnsText").innerText = curQ.opts[curQ.ans];
  document.getElementById("kRoundElapsedText").innerText = formatDurationMinutes(kHostGameStartTime);

  const sortedEntries = Object.entries(kHostPlayers).sort((a, b) => (b[1].score || 0) - (a[1].score || 0));
  const tbody = document.getElementById("kRoundLeaderboardBody");
  tbody.innerHTML = "";

  sortedEntries.forEach(([pid, p], idx) => {
    const rank = idx + 1;
    p.rank = rank;
    const medal = rank === 1 ? `${getSymbolIcon('trophy', 15, 'color:#EAB308;')} #1` : rank === 2 ? `${getSymbolIcon('award', 15, 'color:#94A3B8;')} #2` : rank === 3 ? `${getSymbolIcon('award', 15, 'color:#D97706;')} #3` : `#${rank}`;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><b>${medal}</b></td>
      <td style="text-align: left; font-weight: 700;">${p.isBot ? getSymbolIcon('cpu', 14) : getSymbolIcon('user', 14)} ${escapeHTML(p.name)}</td>
      <td>${escapeHTML(p.year)}</td>
      <td>${p.streak > 0 ? `${getSymbolIcon('flame', 14, 'color:#F97316;')} x` + Number(p.streak) : '-'}</td>
      <td style="font-weight: 800; color: #4F46E5;">${Number(p.score || 0).toLocaleString()}</td>
    `;
    tbody.appendChild(tr);

    if (!isKahootCloudMode()) {
      const targetConn = hostConnections.find(c => c && c.peer === pid);
      if (targetConn && targetConn.open) {
        try {
          targetConn.send({
            type: 'ROUND_LEADERBOARD_INFO',
            yourRank: rank,
            totalPlayers: sortedEntries.length,
            yourScore: p.score
          });
        } catch (e) {}
      }
    }
  });

  if (isKahootCloudMode() && kFullRoomPin) {
    const db = getKahootFirestoreDb();
    const roomRef = db.collection("kahoot_rooms").doc(kFullRoomPin);
    try {
      const batch = db.batch();
      sortedEntries.forEach(([pid, p], idx) => {
        batch.update(roomRef.collection("players").doc(pid), {
          rank: idx + 1,
          score: Number(p.score || 0)
        });
      });
      batch.update(roomRef, {
        status: "leaderboard",
        currentQ: kCurrentQIdx + 1,
        roundResult: {
          qIdx: kCurrentQIdx,
          correctAns: curQ.ans,
          correctText: curQ.opts[curQ.ans],
          totalPlayers: sortedEntries.length
        },
        updatedAt: window.HelloCodeFirebase.serverTimestamp()
      });
      await batch.commit();
    } catch (err) {
      console.warn("Host cloud leaderboard write error:", err);
    }
  } else {
    syncHostRoomToTeacherMonitor('leaderboard');
    broadcastKahoot({ type: 'ROUND_END', correctAns: curQ.ans });
  }

  if (kCurrentQIdx + 1 >= kQuestionsPool.length) {
    launchConfetti();
    document.getElementById("btnHostNextQ").innerHTML = `${getSymbolIcon('trophy', 16)} จบการแข่งขัน`;
  } else {
    document.getElementById("btnHostNextQ").innerHTML = `คำถามข้อถัดไป ${getSymbolIcon('arrowRight', 16)}`;
  }
}

async function hostGoNextQuestion() {
  kCurrentQIdx++;
  if (kCurrentQIdx < kQuestionsPool.length) {
    hostPresentKahootQuestion();
  } else {
    kHostPhase = "finished";
    stopHostHeartbeat();
    stopCloudHostListeners();
    if (isKahootCloudMode() && kFullRoomPin) {
      const db = getKahootFirestoreDb();
      await db.collection("kahoot_rooms").doc(kFullRoomPin).update({
        status: "finished",
        updatedAt: window.HelloCodeFirebase.serverTimestamp()
      }).catch(() => {});
      kFullRoomPin = "";
    } else {
      syncHostRoomToTeacherMonitor('finished');
      broadcastKahoot({ type: 'GAME_OVER' });
    }
    kSwitchView('roleSelect');
  }
}

function renderHostQuestion() { return hostPresentKahootQuestion(); }
function showHostRoundLeaderboard() { return hostShowRoundLeaderboard(); }

function broadcastKahoot(msg) {
  hostConnections.forEach(c => {
    if (c && c.open) {
      try { c.send(msg); } catch (e) {}
    }
  });
}

function stopPlayerHeartbeat() {
  clearInterval(kPlayerHeartbeatInt);
  kPlayerHeartbeatInt = null;
  clearTimeout(kPlayerReconnectTimer);
  kPlayerReconnectTimer = null;
}

function startPlayerHeartbeat() {
  clearInterval(kPlayerHeartbeatInt);
  kPlayerHeartbeatInt = setInterval(() => {
    if (playerConn && playerConn.open) {
      try {
        playerConn.send({
          type: 'HEARTBEAT_PING',
          ts: Date.now(),
          sessionId: getOrCreateKahootSessionId()
        });
      } catch (e) {}
    }
  }, 4000);
}

async function joinKahootRoom(isReconnect = false) {
  const pinRaw = isReconnect ? kActiveJoinPinRaw : document.getElementById("inputRoomPin").value.trim();
  if (!pinRaw || pinRaw.length < 5) {
    showToast("กรุณากรอกรหัส PIN ให้ครบ 5 หลักตามที่แสดงบนหน้าจอหัวหน้าห้อง (เช่น 14582)", "warning");
    return;
  }

  kActiveJoinPinRaw = pinRaw;
  kPlayerLeftIntentionally = false;
  if (!isReconnect) kPlayerReconnectAttempts = 0;

  const btnJoin = document.getElementById("btnJoinRoomSubmit");

  // === CLOUD MODE: FIRESTORE REAL-TIME PLAYER JOIN ===
  if (isKahootCloudMode()) {
    if (!currentUser || !currentUser.isLoggedIn || !currentUser.uid) {
      showToast("กรุณาเข้าสู่ระบบก่อนเข้าร่วมห้องแข่งขัน Kahoot Cloud", "warning");
      if (typeof openLoginModal === 'function') openLoginModal();
      return;
    }

    if (btnJoin) {
      btnJoin.disabled = true;
      btnJoin.innerHTML = `${getSymbolIcon('clock', 16)} กำลังเชื่อมต่อห้อง Cloud...`;
    }

    const db = getKahootFirestoreDb();
    const roomRef = db.collection("kahoot_rooms").doc(pinRaw);
    const playerRef = roomRef.collection("players").doc(currentUser.uid);

    try {
      const roomDoc = await roomRef.get();
      if (!roomDoc.exists) {
        showToast(`ไม่พบห้องแข่งขัน PIN ${pinRaw} กรุณาตรวจสอบรหัสจากหน้าจอหัวหน้าห้อง`, "error");
        return;
      }
      const roomData = roomDoc.data() || {};
      if (roomData.status === 'finished' || isKahootRoomStale(roomData)) {
        showToast(`ห้องแข่งขัน PIN ${pinRaw} ปิดหรือจบการแข่งขันไปแล้ว`, "warning");
        return;
      }

      const existingPlayerDoc = await playerRef.get();
      const alreadyJoined = existingPlayerDoc.exists;
      if (!alreadyJoined && Number(roomData.playerCount || 0) >= KAHOOT_MAX_PLAYERS) {
        showToast(`ขออภัย ห้องนี้มีผู้เข้าร่วมครบจำนวนสูงสุด ${KAHOOT_MAX_PLAYERS} คนแล้ว`, "error");
        return;
      }

      if (!alreadyJoined) {
        await playerRef.set({
          uid: currentUser.uid,
          name: String(currentUser.name || "ผู้เรียน").slice(0, 40),
          year: String(currentUser.year || "ปวช.1").slice(0, 20),
          score: 0,
          streak: 0,
          answered: false,
          submittedQIdx: -1,
          submittedChoice: null,
          submittedTimeLeft: 0,
          gradedQIdx: -1,
          lastCorrect: null,
          lastPoints: 0,
          rank: 0,
          online: true,
          isBot: false,
          joinedAt: Date.now(),
          updatedAt: window.HelloCodeFirebase.serverTimestamp()
        });
        // Complies strictly with firestore.rules affectedKeys().hasOnly(['playerCount', 'updatedAt'])
        await roomRef.update({
          playerCount: window.HelloCodeFirebase.increment(1),
          updatedAt: window.HelloCodeFirebase.serverTimestamp()
        }).catch(() => {});

        currentUser.kahootGamesPlayed = (currentUser.kahootGamesPlayed || 0) + 1;
        if (typeof recordUserActivity === 'function') recordUserActivity('kahoot_join', currentUser.currentUnit || 1, `เข้าร่วม Kahoot Cloud ห้อง ${pinRaw}`);
        if (typeof checkAndUnlockBadges === 'function') checkAndUnlockBadges(false);
        if (typeof saveCurrentProgress === 'function') saveCurrentProgress();
      } else {
        await playerRef.update({
          online: true,
          updatedAt: window.HelloCodeFirebase.serverTimestamp()
        }).catch(() => {});
      }

      stopCloudPlayerListeners();
      kPlayerLastQIdx = -1;
      kPlayerFeedbackShownForQ = -1;
      kPlayerRoomStatus = roomData.status || "lobby";
      kPlayerTotalPlayers = Math.max(1, Number(roomData.playerCount || 1));

      kSwitchView('playerScreen');
      setPlayerConnectionBadge('online', `Cloud Real-Time · ห้อง ${pinRaw}`);
      document.getElementById("playerLobbyWait").classList.remove("hidden");
      document.getElementById("playerAnswerArea").classList.add("hidden");
      document.getElementById("playerFeedback").classList.add("hidden");
      document.getElementById("playerRankBox").classList.add("hidden");
      playSfx('success');

      // Listener 1: Watch Room State (lobby -> playing -> leaderboard -> finished)
      kUnsubPlayerRoom = roomRef.onSnapshot((doc) => {
        if (!doc.exists) {
          stopCloudPlayerListeners();
          showToast("หัวหน้าห้องได้ปิดห้องแข่งขันแล้ว", "info");
          kSwitchView('roleSelect');
          return;
        }
        const r = doc.data() || {};
        kPlayerRoomStatus = r.status || "lobby";

        if (r.status === 'finished') {
          stopCloudPlayerListeners();
          launchConfetti();
          showToast("จบการแข่งขัน Kahoot แล้ว! ขอบคุณที่ร่วมสนุกค่ะ", "success");
          kSwitchView('roleSelect');
          return;
        }

        if (r.status === 'lobby') {
          document.getElementById("playerLobbyWait").classList.remove("hidden");
          document.getElementById("playerAnswerArea").classList.add("hidden");
          document.getElementById("playerFeedback").classList.add("hidden");
          return;
        }

        if (r.status === 'playing' && r.questionData) {
          const qData = r.questionData;
          if (qData.qIdx !== kPlayerLastQIdx) {
            kPlayerLastQIdx = qData.qIdx;
            kPlayerAnswered = false;
            kPlayerFeedbackShownForQ = -1;
            document.getElementById("playerLobbyWait").classList.add("hidden");
            document.getElementById("playerFeedback").classList.add("hidden");
            document.getElementById("playerRankBox").classList.add("hidden");
            document.getElementById("playerAnswerArea").classList.remove("hidden");

            const limit = Number(qData.timeLimit || r.timeLimit || 15);
            const elapsedSec = qData.startedAtMs ? Math.floor((Date.now() - qData.startedAtMs) / 1000) : 0;
            kPlayerTimeLeft = Math.max(1, Math.min(limit, limit - Math.max(0, elapsedSec)));
            document.getElementById("kPlayerTimer").innerText = kPlayerTimeLeft;
            clearInterval(kPlayerTimerInt);
            kPlayerTimerInt = setInterval(() => {
              kPlayerTimeLeft--;
              document.getElementById("kPlayerTimer").innerText = Math.max(0, kPlayerTimeLeft);
              if (kPlayerTimeLeft <= 0) clearInterval(kPlayerTimerInt);
            }, 1000);
          }
          return;
        }

        if (r.status === 'leaderboard') {
          clearInterval(kPlayerTimerInt);
          if (r.roundResult && typeof r.roundResult.totalPlayers === 'number') {
            kPlayerTotalPlayers = Math.max(1, r.roundResult.totalPlayers);
          }
          if (!kPlayerAnswered) {
            document.getElementById("playerLobbyWait").classList.add("hidden");
            document.getElementById("playerAnswerArea").classList.add("hidden");
            document.getElementById("playerFeedback").classList.remove("hidden");
            document.getElementById("playerFeedIcon").innerHTML = getSymbolIcon('clock', 54, 'color:#F59E0B;');
            document.getElementById("playerFeedTitle").innerText = "หมดเวลาตอบคำถาม!";
            document.getElementById("playerFeedDesc").innerText = r.roundResult && r.roundResult.correctText
              ? `คำตอบที่ถูกต้อง: ${r.roundResult.correctText}`
              : "ติดตามอันดับคะแนนบนหน้าจอหลัก";
          }
        }
      }, (err) => {
        setPlayerConnectionBadge('reconnecting', `กำลังเชื่อมต่อ Cloud ใหม่ (${err.code || 'sync'})`);
      });

      // Listener 2: Watch Own Player Doc for Authoritative Host Grading & Rank
      kUnsubPlayerSelf = playerRef.onSnapshot((doc) => {
        if (!doc.exists) return;
        const p = doc.data() || {};

        if (
          kPlayerLastQIdx >= 0 &&
          p.gradedQIdx === kPlayerLastQIdx &&
          kPlayerFeedbackShownForQ !== kPlayerLastQIdx
        ) {
          kPlayerFeedbackShownForQ = kPlayerLastQIdx;
          kPlayerAnswered = true;
          clearInterval(kPlayerTimerInt);
          document.getElementById("playerLobbyWait").classList.add("hidden");
          document.getElementById("playerAnswerArea").classList.add("hidden");
          document.getElementById("playerFeedback").classList.remove("hidden");

          if (p.lastCorrect) {
            playSfx('success');
            document.getElementById("playerFeedIcon").innerHTML = getSymbolIcon('sparkles', 54, 'color:#10B981;');
            document.getElementById("playerFeedTitle").innerHTML = `ถูกต้องยอดเยี่ยม! ${p.streak > 1 ? `(${getSymbolIcon('flame', 16, 'color:#F97316;')} Streak x${Number(p.streak)})` : ''}`;
            document.getElementById("playerFeedDesc").innerText = `+${Number(p.lastPoints || 0).toLocaleString()} คะแนน (รวม: ${Number(p.score || 0).toLocaleString()})`;
          } else {
            playSfx('error');
            document.getElementById("playerFeedIcon").innerHTML = getSymbolIcon('xCircle', 54, 'color:#EF4444;');
            document.getElementById("playerFeedTitle").innerText = "ยังไม่ถูกต้อง สู้ต่อไปในข้อหน้า!";
            document.getElementById("playerFeedDesc").innerText = `คะแนนสะสมรวม: ${Number(p.score || 0).toLocaleString()}`;
          }
        }

        if (kPlayerRoomStatus === 'leaderboard' && Number(p.rank || 0) > 0) {
          document.getElementById("playerRankBox").classList.remove("hidden");
          document.getElementById("playerRankNumber").innerText = `#${Number(p.rank)}`;
          document.getElementById("playerScoreTotalText").innerText = `อันดับที่ ${Number(p.rank)} จาก ${kPlayerTotalPlayers} คน | รวม: ${Number(p.score || 0).toLocaleString()} คะแนน`;
        }
      }, () => {});
    } catch (err) {
      showToast(`ไม่สามารถเข้าร่วมห้อง Kahoot Cloud ได้: ${err.message || err}`, "error");
    } finally {
      if (btnJoin) {
        btnJoin.disabled = false;
        btnJoin.innerHTML = `${getSymbolIcon('link', 16)} เข้าร่วมห้องแข่งขัน`;
      }
    }
    return;
  }

  // === LOCAL DEMO FALLBACK: PeerJS WebRTC ===
  const slot = pinRaw.charAt(0);
  const pin = pinRaw.substring(1);

  if (!isReconnect && btnJoin) {
    btnJoin.disabled = true;
    btnJoin.innerHTML = `${getSymbolIcon('clock', 16)} กำลังเชื่อมต่อห้องแข่งขัน...`;
  } else if (isReconnect) {
    setPlayerConnectionBadge('reconnecting', `กำลังเชื่อมต่อใหม่ (${kPlayerReconnectAttempts}/5)...`);
  }

  try {
    if (typeof Peer === 'undefined') {
      if (btnJoin) {
        btnJoin.disabled = false;
        btnJoin.innerHTML = `${getSymbolIcon('link', 16)} เข้าร่วมห้องแข่งขัน`;
      }
      setPlayerConnectionBadge('offline', 'ไม่พบไลบรารี PeerJS');
      showToast("ยังโหลดไลบรารี WebRTC (PeerJS) ไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่", "error");
      return;
    }
    if (peer && !peer.destroyed) peer.destroy();
    peer = new Peer(null, peerConfig);

    let isConnectedToHost = false;
    let joinTimer = null;

    peer.on('error', (err) => {
      if (!isConnectedToHost && !isReconnect && btnJoin) {
        btnJoin.disabled = false;
        btnJoin.innerHTML = `${getSymbolIcon('link', 16)} เข้าร่วมห้องแข่งขัน`;
      }
      if (!kPlayerLeftIntentionally && isConnectedToHost) {
        schedulePlayerAutoReconnect();
      } else if (!isReconnect) {
        showToast(`เชื่อมต่อห้องแข่งขันไม่ได้: ${err.type || err.message}`, "error");
      }
    });

    peer.on('open', () => {
      const hostPeerId = `c-edu-cprog-kahoot-s${slot}-${pin}`;
      playerConn = peer.connect(hostPeerId, { reliable: true });

      const sendJoin = () => {
        if (playerConn && playerConn.open) {
          playerConn.send({
            type: isReconnect ? 'REJOIN' : 'JOIN',
            sessionId: getOrCreateKahootSessionId(),
            name: (currentUser && currentUser.isLoggedIn) ? currentUser.name : "ผู้เรียน #" + Math.floor(100 + Math.random() * 899),
            year: (currentUser && currentUser.isLoggedIn) ? currentUser.year : "ปวช.1"
          });
        }
      };

      if (playerConn.open) sendJoin();
      else playerConn.on('open', sendJoin);

      joinTimer = setTimeout(() => {
        if (!isConnectedToHost) {
          if (btnJoin) {
            btnJoin.disabled = false;
            btnJoin.innerHTML = `${getSymbolIcon('link', 16)} เข้าร่วมห้องแข่งขัน`;
          }
          if (isReconnect) {
            schedulePlayerAutoReconnect();
          } else {
            showToast("ไม่สามารถเข้าห้องได้ กรุณาตรวจสอบรหัส PIN 5 หลัก หรือรอให้หัวหน้าห้องเปิดห้องก่อน", "error");
            if (peer && !peer.destroyed) peer.destroy();
          }
        }
      }, 7000);

      playerConn.on('close', () => {
        if (kPlayerLeftIntentionally) return;
        setPlayerConnectionBadge('reconnecting', 'สายหลุด · กำลังเชื่อมต่อใหม่...');
        schedulePlayerAutoReconnect();
      });

      playerConn.on('data', (data) => {
        if (!data || typeof data !== 'object') return;

        if (data.type === 'HEARTBEAT_PING') {
          try {
            playerConn.send({ type: 'HEARTBEAT_PONG', ts: data.ts, sessionId: getOrCreateKahootSessionId() });
          } catch (e) {}
          const rttTxt = kLastPingRttMs !== null ? ` · Ping ${kLastPingRttMs} ms` : '';
          setPlayerConnectionBadge('online', `Online${rttTxt}`);
          return;
        }

        if (data.type === 'HEARTBEAT_PONG') {
          if (typeof data.ts === 'number') {
            kLastPingRttMs = Math.max(1, Date.now() - data.ts);
            setPlayerConnectionBadge('online', `Online · Ping ${kLastPingRttMs} ms`);
          }
          return;
        }

        if (data.type === 'JOIN_SUCCESS') {
          isConnectedToHost = true;
          kPlayerReconnectAttempts = 0;
          clearTimeout(joinTimer);
          if (btnJoin) {
            btnJoin.disabled = false;
            btnJoin.innerHTML = `${getSymbolIcon('link', 16)} เข้าร่วมห้องแข่งขัน`;
          }

          if (!data.reconnected && currentUser) {
            currentUser.kahootGamesPlayed = (currentUser.kahootGamesPlayed || 0) + 1;
            if (typeof recordUserActivity === 'function') recordUserActivity('kahoot_join', currentUser.currentUnit || 1, `เข้าร่วม Kahoot ห้อง ${pinRaw}`);
            if (typeof checkAndUnlockBadges === 'function') checkAndUnlockBadges(false);
            if (typeof saveCurrentProgress === 'function') saveCurrentProgress();
          }

          kSwitchView('playerScreen');
          setPlayerConnectionBadge('online', 'Online · เชื่อมต่อสำเร็จ');
          startPlayerHeartbeat();

          if (data.inLiveGame && !data.answered) {
            kPlayerAnswered = false;
            document.getElementById("playerLobbyWait").classList.add("hidden");
            document.getElementById("playerFeedback").classList.add("hidden");
            document.getElementById("playerAnswerArea").classList.remove("hidden");
            kPlayerTimeLeft = Number(data.timeLeft || 10);
            document.getElementById("kPlayerTimer").innerText = kPlayerTimeLeft;
          } else if (!data.reconnected) {
            document.getElementById("playerLobbyWait").classList.remove("hidden");
            document.getElementById("playerAnswerArea").classList.add("hidden");
            document.getElementById("playerFeedback").classList.add("hidden");
            playSfx('success');
          } else {
            showToast("กู้คืนการเชื่อมต่อห้อง Kahoot สำเร็จ!", "success");
          }
        } else if (data.type === 'NEW_QUESTION') {
          kPlayerAnswered = false;
          document.getElementById("playerLobbyWait").classList.add("hidden");
          document.getElementById("playerFeedback").classList.add("hidden");
          document.getElementById("playerRankBox").classList.add("hidden");
          document.getElementById("playerAnswerArea").classList.remove("hidden");

          kPlayerTimeLeft = data.timeLimit;
          document.getElementById("kPlayerTimer").innerText = kPlayerTimeLeft;
          clearInterval(kPlayerTimerInt);
          kPlayerTimerInt = setInterval(() => {
            kPlayerTimeLeft--;
            document.getElementById("kPlayerTimer").innerText = kPlayerTimeLeft;
            if (kPlayerTimeLeft <= 0) clearInterval(kPlayerTimerInt);
          }, 1000);
        } else if (data.type === 'ANSWER_FEEDBACK') {
          document.getElementById("playerAnswerArea").classList.add("hidden");
          document.getElementById("playerFeedback").classList.remove("hidden");

          if (data.correct) {
            playSfx('success');
            document.getElementById("playerFeedIcon").innerHTML = getSymbolIcon('sparkles', 54, 'color:#10B981;');
            document.getElementById("playerFeedTitle").innerHTML = `ถูกต้องยอดเยี่ยม! ${data.streak > 1 ? `(${getSymbolIcon('flame', 16, 'color:#F97316;')} Streak x${Number(data.streak)})` : ''}`;
            document.getElementById("playerFeedDesc").innerText = `+${Number(data.points).toLocaleString()} คะแนน (รวม: ${Number(data.totalScore).toLocaleString()})`;
          } else {
            playSfx('error');
            document.getElementById("playerFeedIcon").innerHTML = getSymbolIcon('xCircle', 54, 'color:#EF4444;');
            document.getElementById("playerFeedTitle").innerText = "ยังไม่ถูกต้อง สู้ต่อไปในข้อหน้า!";
            document.getElementById("playerFeedDesc").innerText = `คะแนนสะสมรวม: ${Number(data.totalScore).toLocaleString()}`;
          }
        } else if (data.type === 'ROUND_LEADERBOARD_INFO') {
          document.getElementById("playerRankBox").classList.remove("hidden");
          document.getElementById("playerRankNumber").innerText = `#${Number(data.yourRank)}`;
          document.getElementById("playerScoreTotalText").innerText = `อันดับที่ ${Number(data.yourRank)} จาก ${Number(data.totalPlayers)} คน | รวม: ${Number(data.yourScore).toLocaleString()} คะแนน`;
        } else if (data.type === 'ROUND_END') {
          clearInterval(kPlayerTimerInt);
          if (!kPlayerAnswered) {
            document.getElementById("playerAnswerArea").classList.add("hidden");
            document.getElementById("playerFeedback").classList.remove("hidden");
            document.getElementById("playerFeedIcon").innerHTML = getSymbolIcon('clock', 54, 'color:#F59E0B;');
            document.getElementById("playerFeedTitle").innerText = "หมดเวลาตอบคำถาม!";
            document.getElementById("playerFeedDesc").innerText = "ติดตามอันดับคะแนนบนหน้าจอหลัก";
          }
        } else if (data.type === 'GAME_OVER') {
          kPlayerLeftIntentionally = true;
          stopPlayerHeartbeat();
          launchConfetti();
          showToast("จบการแข่งขัน Kahoot แล้ว! ขอบคุณที่ร่วมสนุกค่ะ", "success");
          kSwitchView('roleSelect');
        } else if (data.type === 'ROOM_FULL') {
          kPlayerLeftIntentionally = true;
          clearTimeout(joinTimer);
          stopPlayerHeartbeat();
          if (btnJoin) {
            btnJoin.disabled = false;
            btnJoin.innerHTML = `${getSymbolIcon('link', 16)} เข้าร่วมห้องแข่งขัน`;
          }
          showToast(`ขออภัย ห้องนี้มีผู้เข้าร่วมครบจำนวนสูงสุด ${data.maxPlayers || KAHOOT_MAX_PLAYERS} คนแล้ว`, "error");
          kSwitchView('joinPin');
        }
      });
    });
  } catch (err) {
    if (btnJoin) {
      btnJoin.disabled = false;
      btnJoin.innerHTML = `${getSymbolIcon('link', 16)} เข้าร่วมห้องแข่งขัน`;
    }
    showToast(`เกิดข้อผิดพลาดในการเชื่อมต่อห้องแข่งขัน: ${err.message || err}`, "error");
  }
}

function schedulePlayerAutoReconnect() {
  if (isKahootCloudMode()) return;
  if (kPlayerLeftIntentionally || kPlayerReconnectTimer || !kActiveJoinPinRaw) return;
  if (kPlayerReconnectAttempts >= 5) {
    setPlayerConnectionBadge('offline', 'Offline · หมดเวลาเชื่อมต่ออัตโนมัติ');
    showToast("ขาดการเชื่อมต่อจากห้อง Kahoot เกิน 5 ครั้ง กรุณาลองเข้าร่วมใหม่อีกครั้ง", "error");
    return;
  }
  kPlayerReconnectAttempts++;
  const delay = Math.min(6000, 1400 * kPlayerReconnectAttempts);
  kPlayerReconnectTimer = setTimeout(() => {
    kPlayerReconnectTimer = null;
    joinKahootRoom(true);
  }, delay);
}

function schedulePlayerReconnect() { return schedulePlayerAutoReconnect(); }

async function playerChoose(choiceIdx) {
  if (kPlayerAnswered) return;
  kPlayerAnswered = true;
  clearInterval(kPlayerTimerInt);

  document.getElementById("playerAnswerArea").classList.add("hidden");
  document.getElementById("playerFeedback").classList.remove("hidden");
  document.getElementById("playerFeedIcon").innerHTML = getSymbolIcon('send', 54, 'color:#4F46E5;');
  document.getElementById("playerFeedTitle").innerText = "ส่งคำตอบเรียบร้อย!";
  document.getElementById("playerFeedDesc").innerText = "กำลังรอประมวลผลคะแนน...";

  if (isKahootCloudMode() && kActiveJoinPinRaw && currentUser && currentUser.uid) {
    const db = getKahootFirestoreDb();
    try {
      await db.collection("kahoot_rooms")
        .doc(kActiveJoinPinRaw)
        .collection("players")
        .doc(currentUser.uid)
        .update({
          submittedQIdx: kPlayerLastQIdx,
          submittedChoice: Number(choiceIdx),
          submittedTimeLeft: Math.max(0, Number(kPlayerTimeLeft || 0)),
          submittedAt: Date.now(),
          updatedAt: window.HelloCodeFirebase.serverTimestamp()
        });
    } catch (err) {
      kPlayerAnswered = false;
      showToast(`ส่งคำตอบขึ้น Cloud ไม่สำเร็จ: ${err.message || err}`, "error");
      document.getElementById("playerFeedback").classList.add("hidden");
      document.getElementById("playerAnswerArea").classList.remove("hidden");
    }
    return;
  }

  if (playerConn && playerConn.open) {
    try {
      playerConn.send({
        type: 'SUBMIT_ANS',
        sessionId: getOrCreateKahootSessionId(),
        choice: choiceIdx,
        timeLeft: kPlayerTimeLeft
      });
    } catch (e) {
      showToast("ส่งคำตอบไม่สำเร็จ กำลังพยายามเชื่อมต่อใหม่...", "warning");
    }
  }
}

// =========================================================
// 11. FLOATING AI CHAT ASSISTANT (DINO AI) & Z-INDEX OVERLAY SYNC
// =========================================================
const AI_CHAT_CFG_KEY = "c_edu_ai_api_cfg_v1";
let aiChatMessages = [];
let aiPendingQuiz = null;
let aiDinoMoodIdx = 0;
let aiDockObserver = null;

const AI_C_GUIDE_SNIPPETS = [
  {
    keys: ['hello', 'stdio', 'include', 'main', 'โครงสร้าง', 'เริ่มต้น'],
    title: 'โครงสร้างพื้นฐานของโปรแกรมภาษา C',
    body: 'โปรแกรมภาษา C ทุกไฟล์ต้องเริ่มต้นด้วย #include <stdio.h> เพื่อนำเข้าคำสั่งรับ-แสดงผล และทำงานที่ฟังก์ชัน main() เสมอค่ะ',
    code: '#include <stdio.h>\n\nint main() {\n    printf("Hello, HelloCode!\\n");\n    return 0;\n}'
  },
  {
    keys: ['printf', 'scanf', 'รับค่า', 'แสดงผล', '%d', '%f', '%s', '%c', 'specifier'],
    title: 'การใช้งาน printf() และ scanf()',
    body: 'printf ใช้แสดงผล ส่วน scanf ใช้รับค่าจากคีย์บอร์ด โดยต้องใช้ Format Specifier ให้ตรงชนิด (%d=int, %f=float, %c=char, %s=string) และใส่ & หน้าตัวแปรพื้นฐานใน scanf เสมอค่ะ',
    code: 'int age;\nfloat gpa;\nscanf("%d %f", &age, &gpa);\nprintf("อายุ %d ปี เกรด %.2f\\n", age, gpa);'
  },
  {
    keys: ['for loop', 'for', 'ลูป for', 'วนซ้ำ'],
    title: 'การใช้งานคำสั่งวนซ้ำ for loop',
    body: 'for loop เหมาะเมื่อรู้จำนวนรอบที่แน่นอน โดยมี 3 ส่วนคือ (ค่าเริ่มต้น; เงื่อนไขทำต่อ; ปรับค่า)',
    code: '#include <stdio.h>\nint main() {\n    for (int i = 1; i <= 5; i++) {\n        printf("รอบที่ %d\\n", i);\n    }\n    return 0;\n}'
  },
  {
    keys: ['while', 'do-while', 'do while', 'ต่างกัน'],
    title: 'ความต่างระหว่าง while และ do-while',
    body: 'while จะตรวจสอบเงื่อนไขก่อนถ้าเป็นจริงจึงทำงาน (อาจไม่ทำเลยแม้แต่รอบเดียว) ส่วน do-while จะรันคำสั่งในบล็อกก่อนอย่างน้อย 1 รอบ แล้วจึงตรวจสอบเงื่อนไขทีหลัง และต้องปิดท้ายด้วย ; ค่ะ',
    code: '// while: ตรวจเงื่อนไขก่อน\nint x = 1;\nwhile (x <= 3) {\n    printf("%d ", x++);\n}\n\n// do-while: ทำอย่างน้อย 1 รอบเสมอ\nint choice;\ndo {\n    printf("\\nเลือกเมนู (0 ออก): ");\n    scanf("%d", &choice);\n} while (choice != 0);'
  },
  {
    keys: ['break', 'continue', 'หยุดลูป', 'ข้ามรอบ'],
    title: 'คำสั่ง break และ continue',
    body: 'break ใช้หยุดและออกจากลูปหรือ switch-case ทันที ส่วน continue ใช้ข้ามคำสั่งที่เหลือในรอบนั้นเพื่อไปเริ่มรอบถัดไปทันทีค่ะ',
    code: 'for (int i = 1; i <= 5; i++) {\n    if (i == 3) continue; // ข้ามเลข 3\n    if (i == 5) break;    // หยุดเมื่อถึง 5\n    printf("%d ", i);     // แสดง 1 2 4\n}'
  },
  {
    keys: ['if', 'else', 'switch', 'เงื่อนไข', 'case'],
    title: 'คำสั่งเลือกทำตามเงื่อนไข if-else และ switch-case',
    body: 'if / else if ใช้ตรวจสอบเงื่อนไขช่วงคะแนนหรือตรรกะทั่วไป (ใช้ == เปรียบเทียบ ไม่ใช่ =) ส่วน switch-case เหมาะกับการเทียบค่าคงที่ของตัวแปร int หรือ char ค่ะ',
    code: 'if (score >= 80) {\n    printf("Grade A\\n");\n} else if (score >= 50) {\n    printf("Pass\\n");\n} else {\n    printf("Try Again\\n");\n}'
  },
  {
    keys: ['array', 'อาร์เรย์', 'matrix', '2 มิติ', 'index'],
    title: 'ตัวแปรอาร์เรย์ (Array 1 มิติ และ 2 มิติ)',
    body: 'Array เก็บกลุ่มข้อมูลชนิดเดียวกันเรียงต่อกัน โดย Index ช่องแรกเริ่มที่ 0 เสมอ (arr[0] ถึง arr[N-1]) ค่ะ',
    code: 'int scores[5] = {80, 90, 75, 88, 92};\nint sum = 0;\nfor (int i = 0; i < 5; i++) {\n    sum += scores[i];\n}\nprintf("รวม = %d\\n", sum);'
  },
  {
    keys: ['string', 'สตริง', 'strlen', 'strcpy', 'strcmp', 'strcat', 'ข้อความ'],
    title: 'การจัดการข้อความ (String) ในภาษา C',
    body: 'สตริงในภาษา C คือ char array ที่ปิดท้ายด้วย Null Character (\\0) สามารถใช้ฟังก์ชันใน <string.h> เช่น strlen() วัดความยาว, strcpy() คัดลอก, strcmp() เปรียบเทียบ (เท่ากันได้ 0) ค่ะ',
    code: '#include <string.h>\n\nchar name[20] = "HelloCode";\nprintf("ยาว %zu ตัวอักษร\\n", strlen(name));\nif (strcmp(name, "HelloCode") == 0) {\n    printf("ข้อความตรงกัน!\\n");\n}'
  },
  {
    keys: ['pointer', 'พอยน์เตอร์', 'address', '&', '*ptr'],
    title: 'พอยน์เตอร์ (Pointer) และ Address',
    body: 'ตัวแปร Pointer เก็บตำแหน่งที่อยู่ในหน่วยความจำ (Address) ของตัวแปรอื่น ใช้ & เพื่อดึง Address และใช้ * เพื่อเข้าถึงค่าที่ปลายทางค่ะ',
    code: 'int num = 42;\nint *ptr = &num; // ptr ชี้ไปที่ num\nprintf("ค่า = %d, Address = %p\\n", *ptr, (void*)ptr);'
  },
  {
    keys: ['function', 'ฟังก์ชัน', 'void', 'return', 'พารามิเตอร์'],
    title: 'การสร้างฟังก์ชันในภาษา C',
    body: 'การแยกโค้ดออกเป็นฟังก์ชันช่วยให้โปรแกรมอ่านง่ายและนำกลับมาใช้ซ้ำได้ โดยระบุชนิดค่าที่ส่งกลับ (เช่น int, float หรือ void ถ้าไม่ส่งกลับ) พร้อมพารามิเตอร์ค่ะ',
    code: 'int add(int a, int b) {\n    return a + b;\n}\nint main() {\n    printf("ผลบวก = %d\\n", add(10, 25));\n    return 0;\n}'
  }
];

const AI_DINO_JOKES = [
  'รู้ไหมว่าทำไมโปรแกรมเมอร์ภาษา C ถึงใส่แว่นตา? — เพราะมองไม่เห็น Sharp (#) กับหา Semicolon (;) ตอนตี 2 ค่ะ',
  'เพื่อนถามว่า "มีบั๊กกี่ตัว?" ตอบเลย "ไม่รู้ แต่ใส่ printf(\"OK1\"), printf(\"OK2\") ไว้รอบบ้านแล้ว!"',
  'ความต่างของ = กับ == คือ = แปลว่า "ฉันให้ค่านี้แก่เธอ" ส่วน == แปลว่า "เราเข้ากันได้จริงไหม?" — อย่าเผลอใส่ใน if() นะคะ!',
  'while(1) { keepCoding(); } — พักจิบน้ำบ้างนะคะ อย่าลืมใส่ break; ให้ชีวิตด้วย!'
];

function syncAiDockZIndex() {
  const dock = document.getElementById("aiChatDock");
  if (!dock) return;
  const openOverlay = document.querySelector(".modal-backdrop:not(.hidden), .shorts-player-backdrop:not(.hidden), .short-context-menu");
  dock.classList.toggle("behind-overlay", !!openOverlay);

  const aiWin = document.getElementById("aiChatWindow");
  const isChatOpen = !!(aiWin && !aiWin.classList.contains("hidden"));
  const isMobileViewport = window.innerWidth <= 767;
  dock.classList.toggle("ai-fullscreen-open", isChatOpen && isMobileViewport);

  const learnVisible = !document.getElementById("learnSection")?.classList.contains("hidden");
  const studyVisible = learnVisible && !document.getElementById("unitStudyContainer")?.classList.contains("hidden");
  const inPreTest = studyVisible && !document.getElementById("unitPreTestArea")?.classList.contains("hidden");
  const inPostTest = studyVisible && !document.getElementById("unitPostTestArea")?.classList.contains("hidden") && !document.getElementById("postQuizActiveView")?.classList.contains("hidden");
  const kahootVisible = !document.getElementById("kahootSection")?.classList.contains("hidden");
  const inKahootHostLive = kahootVisible && !document.getElementById("kViewHostLive")?.classList.contains("hidden");
  const inKahootPlayerAnswer = kahootVisible && !document.getElementById("kViewPlayerScreen")?.classList.contains("hidden") && !document.getElementById("playerAnswerArea")?.classList.contains("hidden");

  dock.classList.toggle("in-quiz-mode", !isChatOpen && (inPreTest || inPostTest || inKahootHostLive || inKahootPlayerAnswer));

  if (typeof syncBodyScrollLock === "function") syncBodyScrollLock();
}

const AI_CHAT_SESSION_KEY = "c_edu_ai_session_api_key_v1";

function loadAiApiConfig() {
  const fallback = { provider: 'local', apiKey: '', endpoint: '', autoClearOnLogout: true };
  try {
    const raw = safeStorage.getItem(AI_CHAT_CFG_KEY);
    const cfg = raw ? JSON.parse(raw) : {};
    const autoClearOnLogout = (cfg && typeof cfg.autoClearOnLogout === 'boolean') ? cfg.autoClearOnLogout : true;
    let apiKey = (cfg && typeof cfg.apiKey === 'string') ? cfg.apiKey : '';
    if (autoClearOnLogout) {
      try {
        const sessionKey = window.sessionStorage ? window.sessionStorage.getItem(AI_CHAT_SESSION_KEY) : '';
        if (sessionKey) apiKey = sessionKey;
      } catch (e) {}
    }
    return {
      provider: (cfg && cfg.provider) ? cfg.provider : 'local',
      apiKey,
      endpoint: (cfg && typeof cfg.endpoint === 'string') ? cfg.endpoint : '',
      autoClearOnLogout
    };
  } catch (e) {
    return fallback;
  }
}

function updateAiModeBadgeUI() {
  const cfg = loadAiApiConfig();
  const badge = document.getElementById("aiModeBadge");
  if (!badge) return;
  if (cfg.provider === 'gemini' && cfg.apiKey) badge.innerText = "Gemini API Connected";
  else if (cfg.provider === 'openai' && cfg.apiKey) badge.innerText = "External API Connected";
  else badge.innerText = "ผู้ช่วยภาษา C & คุยเล่น";
}

function persistAiApiConfig(cfg) {
  const autoClear = cfg.autoClearOnLogout !== false;
  const cleanEndpoint = (cfg.endpoint || '').trim();
  const cleanKey = (cfg.apiKey || '').trim();
  const provider = cfg.provider || 'local';

  if (autoClear) {
    // Store temporary API keys in sessionStorage when lab auto-clear is active so disk persistence is avoided.
    try {
      if (window.sessionStorage) {
        if (cleanKey) window.sessionStorage.setItem(AI_CHAT_SESSION_KEY, cleanKey);
        else window.sessionStorage.removeItem(AI_CHAT_SESSION_KEY);
      }
    } catch (e) {}
    safeStorage.setItem(AI_CHAT_CFG_KEY, JSON.stringify({
      provider,
      apiKey: (function () { try { return window.sessionStorage ? '' : cleanKey; } catch (e) { return cleanKey; } })(),
      endpoint: cleanEndpoint,
      autoClearOnLogout: true
    }));
  } else {
    try { if (window.sessionStorage) window.sessionStorage.removeItem(AI_CHAT_SESSION_KEY); } catch (e) {}
    safeStorage.setItem(AI_CHAT_CFG_KEY, JSON.stringify({
      provider,
      apiKey: cleanKey,
      endpoint: cleanEndpoint,
      autoClearOnLogout: false
    }));
  }
}

function toggleAiAutoClearKeySetting(enabled) {
  try {
    const cfg = loadAiApiConfig();
    const keyInpVal = (document.getElementById("aiApiKeyInput")?.value || "").trim();
    cfg.apiKey = keyInpVal || cfg.apiKey || '';
    cfg.autoClearOnLogout = !!enabled;
    persistAiApiConfig(cfg);
    showToast(
      enabled
        ? "เปิดการล้าง API Key อัตโนมัติเมื่อออกจากระบบแล้ว (ปลอดภัยสำหรับเครื่องส่วนรวม)"
        : "ปิดการล้าง API Key อัตโนมัติเมื่อออกจากระบบแล้ว",
      "info"
    );
  } catch (e) {
    showToast("ไม่สามารถอัปเดตตัวเลือกความปลอดภัยของ API Key ได้", "warning");
  }
}

function clearAiApiKeyOnLogout() {
  try {
    const cfg = loadAiApiConfig();
    if (cfg.autoClearOnLogout === false) return false;
    const hadKey = !!(cfg.apiKey && cfg.apiKey.trim());
    try { if (window.sessionStorage) window.sessionStorage.removeItem(AI_CHAT_SESSION_KEY); } catch (e) {}
    safeStorage.setItem(AI_CHAT_CFG_KEY, JSON.stringify({
      provider: 'local',
      apiKey: '',
      endpoint: '',
      autoClearOnLogout: true
    }));
    const sel = document.getElementById("aiApiProviderSelect");
    const keyInp = document.getElementById("aiApiKeyInput");
    const epInp = document.getElementById("aiApiEndpointInput");
    if (sel) sel.value = 'local';
    if (keyInp) keyInp.value = '';
    if (epInp) epInp.value = '';
    updateAiModeBadgeUI();
    return hadKey;
  } catch (e) {
    return false;
  }
}

function toggleAiSettingsPane(forceState) {
  const pane = document.getElementById("aiSettingsPane");
  if (!pane) return;
  const shouldShow = typeof forceState === 'boolean' ? forceState : pane.classList.contains("hidden");
  if (shouldShow) {
    const cfg = loadAiApiConfig();
    const sel = document.getElementById("aiApiProviderSelect");
    const keyInp = document.getElementById("aiApiKeyInput");
    const epInp = document.getElementById("aiApiEndpointInput");
    const autoClearChk = document.getElementById("aiAutoClearKeyToggle");
    if (sel) sel.value = cfg.provider || 'local';
    if (keyInp) keyInp.value = cfg.apiKey || '';
    if (epInp) epInp.value = cfg.endpoint || '';
    if (autoClearChk) autoClearChk.checked = (cfg.autoClearOnLogout !== false);
  }
  pane.classList.toggle("hidden", !shouldShow);
}

function saveAiApiConfig() {
  try {
    const provider = document.getElementById("aiApiProviderSelect")?.value || 'local';
    const apiKey = (document.getElementById("aiApiKeyInput")?.value || "").trim();
    const endpoint = (document.getElementById("aiApiEndpointInput")?.value || "").trim();
    const autoClearChk = document.getElementById("aiAutoClearKeyToggle");
    const autoClearOnLogout = autoClearChk ? !!autoClearChk.checked : true;
    persistAiApiConfig({ provider, apiKey, endpoint, autoClearOnLogout });
    updateAiModeBadgeUI();
    toggleAiSettingsPane(false);
    showToast("บันทึกการตั้งค่า AI แล้ว", "success");
  } catch (e) {
    showToast("บันทึกการตั้งค่า AI ไม่สำเร็จ: " + (e.message || e), "error");
  }
}

function resetAiApiConfig() {
  try {
    const autoClearChk = document.getElementById("aiAutoClearKeyToggle");
    const autoClearOnLogout = autoClearChk ? !!autoClearChk.checked : true;
    try { if (window.sessionStorage) window.sessionStorage.removeItem(AI_CHAT_SESSION_KEY); } catch (e) {}
    safeStorage.setItem(AI_CHAT_CFG_KEY, JSON.stringify({
      provider: 'local',
      apiKey: '',
      endpoint: '',
      autoClearOnLogout
    }));
    const sel = document.getElementById("aiApiProviderSelect");
    const keyInp = document.getElementById("aiApiKeyInput");
    const epInp = document.getElementById("aiApiEndpointInput");
    if (sel) sel.value = 'local';
    if (keyInp) keyInp.value = '';
    if (epInp) epInp.value = '';
    updateAiModeBadgeUI();
    toggleAiSettingsPane(false);
    showToast("ล้าง API Key และสลับกลับเป็นโหมดในระบบแล้ว", "info");
  } catch (e) {
    showToast("ไม่สามารถล้าง API Key ได้", "error");
  }
}

function initAiChatAssistant() {
  const autoClearChk = document.getElementById("aiAutoClearKeyToggle");
  if (autoClearChk) autoClearChk.checked = (loadAiApiConfig().autoClearOnLogout !== false);
  updateAiModeBadgeUI();
  if (aiChatMessages.length === 0) {
    const name = (currentUser && currentUser.isLoggedIn && currentUser.name) ? currentUser.name : "เพื่อนใหม่";
    aiChatMessages.push({
      role: 'bot',
      text: `สวัสดีค่ะ ${name}! ฉันคือ Dino AI ประจำแพลตฟอร์ม HelloCode\nถามเรื่องโค้ดภาษา C, ค้นหาสรุปบทเรียน, สุ่มโจทย์ฝึกทำ หรือทักมาคุยเล่นแก้เบื่อได้เลยนะ!`,
      code: ''
    });
  }
  renderAiMessages();

  if (!aiDockObserver && document.body && typeof MutationObserver !== 'undefined') {
    aiDockObserver = new MutationObserver(() => syncAiDockZIndex());
    aiDockObserver.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'style']
    });
  }
  syncAiDockZIndex();
}

function toggleAiChatWindow(forceState) {
  const win = document.getElementById("aiChatWindow");
  const fab = document.getElementById("aiChatFab");
  if (!win || !fab) return;
  const shouldOpen = typeof forceState === 'boolean' ? forceState : win.classList.contains("hidden");
  win.classList.toggle("hidden", !shouldOpen);
  fab.setAttribute("aria-expanded", shouldOpen ? "true" : "false");
  if (shouldOpen) {
    renderAiMessages();
    setTimeout(() => document.getElementById("aiChatInput")?.focus(), 80);
  }
  syncAiDockZIndex();
}

function clearAiChatHistory() {
  aiPendingQuiz = null;
  aiChatMessages = [{
    role: 'bot',
    text: 'เริ่มห้องสนทนาใหม่เรียบร้อย! อยากให้ Dino AI ช่วยอธิบายเรื่องอะไรของภาษา C หรือคุยเล่นเรื่องไหนดีคะ?',
    code: ''
  }];
  renderAiMessages();
}

function copyAiSnippet(btn) {
  const code = btn?.getAttribute("data-code") || "";
  copyTextToClipboard(code);
  showToast("คัดลอกโค้ด C แล้ว", "success");
}

function renderAiMessages() {
  const container = document.getElementById("aiChatMessages");
  if (!container) return;
  container.innerHTML = aiChatMessages.map(msg => {
    const isUser = msg.role === 'user';
    const formattedText = escapeHTML(msg.text || "").replace(/\n/g, "<br>");
    const codeHtml = msg.code
      ? `<pre class="ai-code-block">${escapeHTML(msg.code)}</pre><button type="button" class="ai-code-copy-btn" data-code="${escapeHTML(msg.code)}" onclick="copyAiSnippet(this)">${getSymbolIcon('copy', 12)} คัดลอกโค้ด</button>`
      : "";
    return `
      <div class="ai-msg-row ${isUser ? 'user' : 'bot'}">
        <div class="ai-msg-bubble">
          <div>${formattedText}</div>
          ${codeHtml}
        </div>
      </div>
    `;
  }).join("");
  container.scrollTop = container.scrollHeight;
}

function askAiQuickPrompt(promptText) {
  const inp = document.getElementById("aiChatInput");
  if (inp) inp.value = promptText;
  processAiUserPrompt(promptText);
}

async function handleAiChatSubmit(e) {
  e.preventDefault();
  const inp = document.getElementById("aiChatInput");
  if (!inp) return;
  const text = inp.value.trim();
  if (!text) return;
  inp.value = "";
  await processAiUserPrompt(text);
}

function buildUserProgressAiReply() {
  if (!currentUser || !currentUser.isLoggedIn) {
    return {
      text: 'ตอนนี้ยังไม่ได้เข้าสู่ระบบนะคะ — สามารถเริ่มเรียนหน่วยที่ 1 หรือกดเข้าสู่ระบบที่มุมขวาบนเพื่อสะสม XP และบันทึกคะแนนได้เลย!',
      code: ''
    };
  }
  if (currentUser.role === 'teacher') {
    const students = Object.values(loadUserDatabase()).filter(u => u.role === 'student').length;
    return {
      text: `บัญชีครู ${currentUser.name}: ปัจจุบันมีนักเรียนในระบบ ${students} คน, คลิปสั้น ${cachedShortsMeta.length} คลิป และภารกิจ ${DataService.Quests.getAll().length} รายการค่ะ`,
      code: ''
    };
  }
  normalizeUserRecord(currentUser);
  const lv = getLevelInfo(currentUser.xp || 0);
  const target = getNextSequentialTarget();
  let doneUnits = 0;
  for (let i = 1; i <= 5; i++) if (currentUser.units[i]?.postDone) doneUnits++;
  const labsCount = (currentUser.claimedLabXp || []).length;
  return {
    text: `สรุปความก้าวหน้าของคุณ ${currentUser.name}:\n• เลเวล: ${lv.title} (${currentUser.xp || 0} XP)\n• จบแล้ว: ${doneUnits}/5 หน่วย · แล็บ ${labsCount}/25 แล็บ\n• เป้าหมายถัดไป: ${target.unitTitle} (${target.stepText})`,
    code: ''
  };
}

function startRandomAiQuiz() {
  const units = Object.keys(fullQuestionBank || {});
  if (!units.length) return { text: 'ยังไม่พบคลังข้อสอบในระบบค่ะ', code: '' };
  const uPick = units[Math.floor(Math.random() * units.length)];
  const pool = fullQuestionBank[uPick] || [];
  if (!pool.length) return { text: 'ยังไม่พบคำถามในหน่วยนี้ค่ะ', code: '' };
  const qObj = pool[Math.floor(Math.random() * pool.length)];

  const indexedOpts = qObj.opts.map((opt, idx) => ({ text: opt, isRight: idx === qObj.ans }));
  for (let i = indexedOpts.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indexedOpts[i], indexedOpts[j]] = [indexedOpts[j], indexedOpts[i]];
  }
  const correctPos = indexedOpts.findIndex(o => o.isRight) + 1;
  aiPendingQuiz = { question: qObj.q, correctChoice: correctPos, correctText: indexedOpts[correctPos - 1].text, unit: uPick };

  const choicesTxt = indexedOpts.map((o, idx) => `${idx + 1}. ${o.text}`).join("\n");
  return {
    text: `คำถามภาษา C (หน่วยที่ ${uPick}):\n${qObj.q}\n\n${choicesTxt}\n\nพิมพ์เลข 1, 2, 3 หรือ 4 เพื่อตอบได้เลยค่ะ!`,
    code: ''
  };
}

function generateLocalAiReply(rawText) {
  const text = rawText.trim();
  const lower = text.toLowerCase();

  // 1. Check active mini-quiz answer (1-4)
  if (aiPendingQuiz && /^[1-4]$/.test(lower)) {
    const pick = parseInt(lower, 10);
    const quiz = aiPendingQuiz;
    aiPendingQuiz = null;
    if (pick === quiz.correctChoice) {
      playSfx('success');
      return {
        text: `ถูกต้องเก่งมากค่ะ! ข้อที่ ${quiz.correctChoice} คือคำตอบที่ถูก (${quiz.correctText})\nอยากลองอีกข้อพิมพ์ "สุ่มโจทย์" ได้เลย!`,
        code: ''
      };
    }
    return {
      text: `ยังไม่ถูกค่ะ คำตอบที่ถูกต้องคือข้อ ${quiz.correctChoice}: "${quiz.correctText}"\nลองพิมพ์ "สุ่มโจทย์" เพื่อแก้มือใหม่ได้นะ!`,
      code: ''
    };
  }

  // 2. Rock-Paper-Scissors casual mini-game
  const rpsChoices = ['ค้อน', 'กรรไกร', 'กระดาษ'];
  if (lower.includes('เป่ายิ้งฉุบ') || lower.includes('เป่า ยิ้ง ฉุบ')) {
    return {
      text: 'มาเล่นเป่ายิ้งฉุบกัน! พิมพ์คำว่า "ค้อน", "กรรไกร" หรือ "กระดาษ" ส่งมาได้เลยค่ะ',
      code: ''
    };
  }
  const matchedRps = rpsChoices.find(c => lower === c || lower.includes(`ออก${c}`));
  if (matchedRps) {
    const dinoPick = rpsChoices[Math.floor(Math.random() * 3)];
    let verdict = 'เสมอกัน!';
    if (
      (matchedRps === 'ค้อน' && dinoPick === 'กรรไกร') ||
      (matchedRps === 'กรรไกร' && dinoPick === 'กระดาษ') ||
      (matchedRps === 'กระดาษ' && dinoPick === 'ค้อน')
    ) {
      verdict = 'คุณชนะ Dino แล้ว เย้!';
    } else if (matchedRps !== dinoPick) {
      verdict = 'รอบนี้ Dino ชนะนะ ลองอีกตาไหมคะ!';
    }
    return { text: `คุณออก "${matchedRps}" · Dino ออก "${dinoPick}"\nผลคือ: ${verdict}`, code: '' };
  }

  // 3. Quiz trigger
  if (lower.includes('สุ่มโจทย์') || lower.includes('quiz') || lower.includes('ถามคำถาม') || lower.includes('ทดสอบ')) {
    return startRandomAiQuiz();
  }

  // 4. Progress & XP inquiry
  if (lower.includes('ความก้าวหน้า') || lower.includes('คะแนน') || lower.includes('เลเวล') || lower.includes('เรียนถึงไหน') || lower.includes('สถิติ')) {
    return buildUserProgressAiReply();
  }

  // 5. Jokes & casual fun chat
  if (lower.includes('มุก') || lower.includes('ตลก') || lower.includes('เบื่อ') || lower.includes('คุยเล่น') || lower.includes('ชวนคุย') || lower.includes('เรื่องสนุก')) {
    const joke = AI_DINO_JOKES[aiDinoMoodIdx % AI_DINO_JOKES.length];
    aiDinoMoodIdx++;
    return {
      text: `${joke}\n\nจะชวนเล่น "เป่ายิ้งฉุบ", ให้ "สุ่มโจทย์", หรือถามโค้ดภาษา C ต่อก็ได้นะ!`,
      code: ''
    };
  }

  if (lower.includes('เหนื่อย') || lower.includes('ท้อ') || lower.includes('ง่วง') || lower.includes('ยากจัง') || lower.includes('ไม่ไหว')) {
    return {
      text: 'พักสายตาสัก 5 นาที ดื่มน้ำเย็นๆ แล้วค่อยกลับมาลองทำแล็บสั้นๆ ทีละนิดนะคะ Dino AI อยู่เป็นเพื่อนช่วยอธิบายทุกเมื่อ!',
      code: ''
    };
  }

  if (lower.includes('ชื่ออะไร') || lower.includes('เป็นใคร') || lower.includes('ทำอะไรได้')) {
    return {
      text: 'ฉันคือ Dino AI ผู้ช่วยประจำ HelloCode! ถามได้ทั้งเรื่องไวยากรณ์ภาษา C, ตัวอย่างโค้ดพร้อมรัน, เช็กคะแนน XP, สุ่มข้อสอบฝึกทำ หรือจะชวนคุยเล่นและเป่ายิ้งฉุบก็ได้หมดเลยค่ะ',
      code: ''
    };
  }

  if (lower.includes('ขอบคุณ') || lower.includes('เก่งมาก') || lower.includes('เยี่ยม')) {
    return { text: 'ยินดีมากค่ะ! มีคำถามโค้ดส่วนไหนหรืออยากลองให้ช่วยตรวจแนวคิด แวะมาคุยกับ Dino ได้ตลอดเวลาเลยนะคะ', code: '' };
  }

  // 6. C Programming knowledge guides + syntax examples
  let bestGuide = null;
  let bestScore = 0;
  AI_C_GUIDE_SNIPPETS.forEach(item => {
    let hit = 0;
    item.keys.forEach(k => {
      if (lower.includes(k)) hit += k.length;
    });
    if (hit > bestScore) {
      bestScore = hit;
      bestGuide = item;
    }
  });
  if (bestGuide) {
    return {
      text: `${bestGuide.title}\n${bestGuide.body}`,
      code: bestGuide.code || ''
    };
  }

  // 7. Dynamic search across full detailedConcepts in curriculum
  if (typeof detailedConcepts === 'object' && typeof topicTitles === 'object') {
    const tokens = lower.split(/\s+/).filter(t => t.length >= 2);
    let bestConceptMatch = null;
    let bestConceptHits = 0;

    Object.keys(detailedConcepts).forEach(key => {
      const entry = detailedConcepts[key];
      if (!entry) return;
      const [uStr, tStr] = key.split("_");
      const title = (topicTitles[uStr] && topicTitles[uStr][tStr]) ? topicTitles[uStr][tStr] : key;
      const haystack = `${title} ${entry.how || ''} ${entry.extra || ''} ${entry.analogy || ''}`.toLowerCase();
      let score = 0;
      tokens.forEach(tok => {
        if (haystack.includes(tok)) score++;
      });
      if (title.toLowerCase().includes(lower)) score += 5;
      if (score > bestConceptHits) {
        bestConceptHits = score;
        bestConceptMatch = { title, entry };
      }
    });

    if (bestConceptMatch && bestConceptHits > 0) {
      const { title, entry } = bestConceptMatch;
      const replyText = `${title}\n${entry.how || ''}${entry.pitfall ? `\n\nจุดที่พบบ่อย: ${entry.pitfall}` : ''}`;
      return { text: replyText, code: entry.syntax || '' };
    }
  }

  // 8. Greeting fallback
  if (/^(สวัสดี|หวัดดี|ดีครับ|ดีค่ะ|ดีจ้า|hello|hi|hey)\b/i.test(lower)) {
    const who = (currentUser && currentUser.isLoggedIn) ? currentUser.name : "เพื่อนใหม่";
    return {
      text: `สวัสดีค่ะ ${who}! วันนี้อยากศึกษาภาษา C เรื่องไหน (เช่น for loop, array, pointer, printf) หรืออยากคุยเล่น / สุ่มโจทย์ฝึกมือดีคะ?`,
      code: ''
    };
  }

  // 9. Friendly catch-all
  return {
    text: `รับทราบค่ะ! ตอนนี้สามารถถามเรื่องภาษา C (เช่น for, while, if-else, array, string, scanf, printf, pointer, function), เช็กคะแนน XP, สุ่มโจทย์ C หรือชวนคุยเล่น & เป่ายิ้งฉุบกับ Dino AI ได้เลยนะ`,
    code: ''
  };
}

async function callExternalAiIfConfigured(promptText) {
  const cfg = loadAiApiConfig();
  if (!cfg || !cfg.apiKey || cfg.provider === 'local') return null;

  const systemPrompt = "You are Dino AI, a friendly Thai interactive tutor for HelloCode (C Programming Learning Platform). Respond concisely in Thai, support both friendly casual chat and accurate C programming explanations with clean C code blocks wrapped in ```c ... ```.";
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), 20000) : null;

  try {
    if (cfg.provider === 'gemini') {
      const url = cfg.endpoint || `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
      const resp = await fetch(url, {
        method: 'POST',
        signal: controller ? controller.signal : undefined,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${systemPrompt}\n\nUser: ${promptText}` }] }]
        })
      });
      if (!resp.ok) {
        const errInfo = resp.status === 401 || resp.status === 403 ? "API Key ไม่ถูกต้องหรือหมดอายุ" : `HTTP ${resp.status}`;
        throw new Error(errInfo);
      }
      const data = await resp.json();
      const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      return raw ? parseAiMarkdownCodeReply(raw) : null;
    }

    if (cfg.provider === 'openai') {
      const url = cfg.endpoint || "https://api.openai.com/v1/chat/completions";
      const resp = await fetch(url, {
        method: 'POST',
        signal: controller ? controller.signal : undefined,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${cfg.apiKey}`
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: promptText }
          ]
        })
      });
      if (!resp.ok) {
        const errInfo = resp.status === 401 || resp.status === 403 ? "API Key ไม่ถูกต้องหรือไม่ได้รับสิทธิ์" : `HTTP ${resp.status}`;
        throw new Error(errInfo);
      }
      const data = await resp.json();
      const raw = data?.choices?.[0]?.message?.content;
      return raw ? parseAiMarkdownCodeReply(raw) : null;
    }
    return null;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function parseAiMarkdownCodeReply(rawText) {
  const codeMatch = rawText.match(/```(?:c|cpp)?\s*([\s\S]*?)```/i);
  if (!codeMatch) return { text: rawText.trim(), code: '' };
  const cleanedText = rawText.replace(codeMatch[0], "").trim();
  return { text: cleanedText, code: (codeMatch[1] || "").trim() };
}

async function processAiUserPrompt(text) {
  aiChatMessages.push({ role: 'user', text, code: '' });
  renderAiMessages();

  let reply = null;
  const cfg = loadAiApiConfig();
  if (cfg.provider !== 'local' && cfg.apiKey) {
    const loadingIdx = aiChatMessages.length;
    aiChatMessages.push({ role: 'bot', text: 'Dino AI กำลังเชื่อมต่อ API ภายนอก...', code: '' });
    renderAiMessages();
    try {
      reply = await callExternalAiIfConfigured(text);
    } catch (err) {
      reply = null;
      const reason = err?.name === 'AbortError' ? 'หมดเวลาเชื่อมต่อ (Timeout)' : (err?.message || 'เครือข่ายขัดข้อง');
      showToast(`เชื่อมต่อ API ภายนอกไม่สำเร็จ (${reason}) — สลับใช้โหมดออฟไลน์อัตโนมัติ`, "warning");
    } finally {
      if (aiChatMessages[loadingIdx] && aiChatMessages[loadingIdx].text === 'Dino AI กำลังเชื่อมต่อ API ภายนอก...') {
        aiChatMessages.splice(loadingIdx, 1);
      }
    }
  }
  if (!reply) {
    reply = generateLocalAiReply(text);
  }

  aiChatMessages.push({ role: 'bot', text: reply.text, code: reply.code || '' });
  if (aiChatMessages.length > 50) aiChatMessages = aiChatMessages.slice(-50);
  renderAiMessages();
}
