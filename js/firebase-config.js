// =========================================================
// HelloCode - Firebase Cloud Configuration & Initialization
// โหลดไฟล์นี้หลัง Firebase SDK v10 (compat) และก่อน js/app.js
// =========================================================
// วิธีเชื่อมต่อ Firebase จริง (ทำครั้งเดียว):
// 1. ไปที่ https://console.firebase.google.com/ -> สร้างโปรเจกต์ -> เพิ่ม Web App (</>)
// 2. เปิดใช้งาน Authentication (Email/Password), Cloud Firestore และ Firebase Storage
// 3. นำค่า firebaseConfig มาแทนที่ค่าว่างด้านล่าง
// 4. Deploy ไฟล์ firestore.rules, storage.rules และตั้งค่า CORS ด้วยไฟล์ cors.json
// =========================================================

window.HELLOCODE_FIREBASE_CONFIG = {
  apiKey: "AIzaSyDtvXNjGrI3XoR8VzJu3vaanj9nlRTnbWY",
  authDomain: "hellocode-01.firebaseapp.com",
  projectId: "hellocode-01",
  storageBucket: "hellocode-01.firebasestorage.app",
  messagingSenderId: "622319998077",
  appId: "1:622319998077:web:dbdb24e8ce33e727cf8d14"
};

window.HELLOCODE_CLOUDINARY_CONFIG = {
  cloudName: "ydfap9a4",
  uploadPreset: "hellocode"
};

window.HelloCodeFirebase = (function createHelloCodeFirebaseController() {
  const state = {
    initialized: false,
    mode: "local",
    app: null,
    auth: null,
    db: null,
    storage: null,
    persistenceEnabled: false,
    lastError: null
  };

  function isNonEmptyRealValue(val, minLen) {
    if (typeof val !== "string") return false;
    const trimmed = val.trim();
    if (trimmed.length < minLen) return false;
    if (/^(YOUR_|REPLACE_|PUT_|EXAMPLE|TEST_API_KEY)/i.test(trimmed)) return false;
    return true;
  }

  function isConfigured() {
    const cfg = window.HELLOCODE_FIREBASE_CONFIG;
    return Boolean(
      cfg &&
      typeof window.firebase !== "undefined" &&
      isNonEmptyRealValue(cfg.apiKey, 10) &&
      isNonEmptyRealValue(cfg.authDomain, 5) &&
      isNonEmptyRealValue(cfg.projectId, 3)
    );
  }

  function updateCloudStatusUI() {
    const pill = document.getElementById("cloudSyncStatusPill");
    const textEl = document.getElementById("cloudSyncStatusText");
    if (!pill || !textEl) return;

    pill.classList.remove("online", "offline-cache", "local");
    if (state.mode === "firebase") {
      if (navigator.onLine === false) {
        pill.classList.add("offline-cache");
        textEl.innerText = "Cloud (Offline Cache)";
        pill.title = "Firebase Cloud Sync (กำลังทำงานบนแคชออฟไลน์ จะซิงก์อัตโนมัติเมื่อต่อเน็ต)";
      } else {
        pill.classList.add("online");
        textEl.innerText = "Online Cloud";
        pill.title = "เชื่อมต่อ Firebase Cloud Sync แบบ Real-Time พร้อมใช้งานข้ามอุปกรณ์";
      }
    } else {
      pill.classList.add("local");
      textEl.innerText = "Offline Local Demo";
      pill.title = "โหมดสาธิตในเครื่อง — กรอกค่าใน js/firebase-config.js เพื่อเปิดใช้ Cloud Sync ข้ามอุปกรณ์";
    }
  }

  function init() {
    if (state.initialized) {
      updateCloudStatusUI();
      return {
        mode: state.mode,
        persistenceEnabled: state.persistenceEnabled,
        error: state.lastError
      };
    }
    state.initialized = true;

    if (!isConfigured()) {
      state.mode = "local";
      updateCloudStatusUI();
      return { mode: "local", persistenceEnabled: false, error: null };
    }

    try {
      const cfg = window.HELLOCODE_FIREBASE_CONFIG;
      state.app = (window.firebase.apps && window.firebase.apps.length > 0)
        ? window.firebase.app()
        : window.firebase.initializeApp(cfg);

      if (typeof window.firebase.auth === "function") {
        state.auth = window.firebase.auth();
      }
      if (typeof window.firebase.firestore === "function") {
        state.db = window.firebase.firestore();
        if (typeof state.db.enablePersistence === "function") {
          state.db.enablePersistence({ synchronizeTabs: true })
            .then(() => {
              state.persistenceEnabled = true;
            })
            .catch((err) => {
              if (err && err.code === "failed-precondition") {
                console.warn("[HelloCode] Firestore Offline Persistence: multiple tabs open, using memory cache for this tab.");
              } else if (err && err.code === "unimplemented") {
                console.warn("[HelloCode] Firestore Offline Persistence is not supported by this browser.");
              } else {
                console.warn("[HelloCode] Firestore persistence warning:", err);
              }
            });
        }
      }
      if (typeof window.firebase.storage === "function") {
        state.storage = window.firebase.storage();
      }

      state.mode = (state.auth && state.db) ? "firebase" : "local";
      state.lastError = null;
    } catch (err) {
      console.error("[HelloCode] Firebase initialization error:", err);
      state.mode = "local";
      state.db = null;
      state.auth = null;
      state.storage = null;
      state.lastError = err && err.message ? err.message : String(err);
    }

    window.addEventListener("online", updateCloudStatusUI);
    window.addEventListener("offline", updateCloudStatusUI);
    updateCloudStatusUI();

    return {
      mode: state.mode,
      persistenceEnabled: state.persistenceEnabled,
      error: state.lastError
    };
  }

  function serverTimestamp() {
    if (window.firebase && window.firebase.firestore && window.firebase.firestore.FieldValue) {
      return window.firebase.firestore.FieldValue.serverTimestamp();
    }
    return Date.now();
  }

  function increment(n) {
    if (window.firebase && window.firebase.firestore && window.firebase.firestore.FieldValue) {
      return window.firebase.firestore.FieldValue.increment(n);
    }
    return n;
  }

  function arrayUnion(...items) {
    if (window.firebase && window.firebase.firestore && window.firebase.firestore.FieldValue) {
      return window.firebase.firestore.FieldValue.arrayUnion(...items);
    }
    return items;
  }

  function arrayRemove(...items) {
    if (window.firebase && window.firebase.firestore && window.firebase.firestore.FieldValue) {
      return window.firebase.firestore.FieldValue.arrayRemove(...items);
    }
    return items;
  }

  return {
    init,
    isConfigured,
    isOnlineCloud() {
      if (!state.initialized) init();
      return state.mode === "firebase" && Boolean(state.db && state.auth);
    },
    getMode() {
      if (!state.initialized) init();
      return state.mode;
    },
    getApp() { return state.app; },
    getAuth() { return state.auth; },
    getDb() { return state.db; },
    getStorage() { return state.storage; },
    updateCloudStatusUI,
    serverTimestamp,
    increment,
    arrayUnion,
    arrayRemove
  };
})();
