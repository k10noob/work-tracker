/* ============================================================
   WORK HOURS TRACKER — Firebase Edition
   ------------------------------------------------------------
   • Firebase Auth (Email/Password + Google Sign-In)
   • Firestore for cross-device sync
   • Real-time updates
   • localStorage migration for existing users
   ============================================================ */

import { useState, useEffect, useMemo, useRef } from "react";
import {
  Home, Calendar as CalendarIcon, BarChart3, Plus, X,
  ChevronLeft, ChevronRight, Download, Clock, AlertCircle,
  Palmtree, History as HistoryIcon, TrendingUp, CheckCircle2,
  Trash2, Sparkles, LogOut, Mail, Lock, User, Loader2,
} from "lucide-react";

/* ============================================================
   FIREBASE SETUP
   ============================================================
   STEP 1: Go to https://console.firebase.google.com
   STEP 2: Create a new project (e.g., "work-tracker")
   STEP 3: Click "Web" icon → register app → copy the config
   STEP 4: Enable Authentication → Sign-in method:
           ✓ Email/Password
           ✓ Google
   STEP 5: Create Firestore Database → Start in test mode
   STEP 6: Paste your config below 👇
   STEP 7: Run: npm install firebase
   ============================================================ */

import { initializeApp } from "firebase/app";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signInWithPopup, GoogleAuthProvider, signOut, onAuthStateChanged,
  updateProfile,
} from "firebase/auth";
import {
  getFirestore, doc, setDoc, onSnapshot, serverTimestamp,
} from "firebase/firestore";

// 🔑 REPLACE THIS WITH YOUR FIREBASE CONFIG
const firebaseConfig = {
  apiKey: "AIzaSyCvjNTNAJRKOm5FswtKKeeqPRkUap2_1S4",
  authDomain: "work-tracker-5a3d6.firebaseapp.com",
  projectId: "work-tracker-5a3d6",
  storageBucket: "work-tracker-5a3d6.firebasestorage.app",
  messagingSenderId: "193598395573",
  appId: "1:193598395573:web:612c77c0b3ea11dd029afc",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const googleProvider = new GoogleAuthProvider();

/* ============================================================
   CONSTANTS
   ============================================================ */
const TARGET_MINUTES = 510;
const ANNUAL_LEAVES = 20;
const LOCAL_KEY = "work_tracker_v1";

/* ============================================================
   DATE & TIME HELPERS
   ============================================================ */
const pad = (n) => String(n).padStart(2, "0");
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseKey = (k) => {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const todayKey = () => dateKey(new Date());

const formatTime12 = (input) => {
  const d = typeof input === "string" ? new Date(input) : input;
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${pad(h)}:${pad(m)} ${ampm}`;
};

const formatHMS = (totalSeconds) => {
  const sign = totalSeconds < 0 ? "-" : "";
  const s = Math.abs(Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${sign}${pad(h)}:${pad(m)}:${pad(sec)}`;
};

const formatHM = (minutes) => {
  if (minutes === 0 || minutes == null) return "0h 0m";
  const sign = minutes < 0 ? "-" : minutes > 0 ? "+" : "";
  const abs = Math.abs(Math.round(minutes));
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${sign}${h}h ${m}m`;
};

const formatHMNoSign = (minutes) => {
  const abs = Math.abs(Math.round(minutes));
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${h}h ${m}m`;
};

const longDate = (d) => {
  const days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  return `${days[d.getDay()]}, ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
};

const shortDate = (d) => {
  const days = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${pad(d.getDate())} ${months[d.getMonth()]} ${d.getFullYear()}, ${days[d.getDay()]}`;
};

const monthLabel = (year, month) => {
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  return `${months[month]} ${year}`;
};

const firstSaturday = (year, month) => {
  for (let day = 1; day <= 7; day++) {
    if (new Date(year, month, day).getDay() === 6) return day;
  }
  return null;
};

const isOff = (d) => {
  if (d.getDay() === 0) return true;
  if (d.getDay() === 6 && d.getDate() === firstSaturday(d.getFullYear(), d.getMonth())) return true;
  return false;
};

const dayKind = (d) => {
  if (d.getDay() === 0) return "sunday";
  if (d.getDay() === 6 && d.getDate() === firstSaturday(d.getFullYear(), d.getMonth())) return "first-sat";
  return "working";
};

const fyStartFor = (d) => {
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return new Date(y, 3, 1);
};
const fyEndFor = (d) => {
  const s = fyStartFor(d);
  return new Date(s.getFullYear() + 1, 2, 31);
};
const fyLabel = (d) => {
  const s = fyStartFor(d);
  return `Apr ${s.getFullYear()} – Mar ${s.getFullYear() + 1}`;
};

const workingDaysInMonth = (year, month) => {
  const last = new Date(year, month + 1, 0).getDate();
  let n = 0;
  for (let d = 1; d <= last; d++) {
    if (!isOff(new Date(year, month, d))) n++;
  }
  return n;
};

/* ============================================================
   FIRESTORE SYNC HOOK
   ------------------------------------------------------------
   • Real-time listens on users/{uid}/data document
   • Debounced writes (500ms) to avoid excessive Firestore costs
   • Keeps local state instant; syncs cloud in background
   ============================================================ */
function useFirestoreState(userId) {
  const [state, setState] = useState({ logs: {}, activeTimer: null });
  const [loading, setLoading] = useState(true);
  const writeTimer = useRef(null);
  const isLocalUpdate = useRef(false);

  // Listen for remote changes
  useEffect(() => {
    if (!userId) return;
    const ref = doc(db, "users", userId);
    const unsub = onSnapshot(ref, (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        if (!isLocalUpdate.current) {
          setState({
            logs: data.logs || {},
            activeTimer: data.activeTimer || null,
          });
        }
        isLocalUpdate.current = false;
      }
      setLoading(false);
    }, (err) => {
      console.error("Firestore read error:", err);
      setLoading(false);
    });
    return unsub;
  }, [userId]);

  // Debounced write to Firestore
  const updateState = (updater) => {
    setState((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      isLocalUpdate.current = true;

      if (writeTimer.current) clearTimeout(writeTimer.current);
      writeTimer.current = setTimeout(async () => {
        if (!userId) return;
        try {
          await setDoc(doc(db, "users", userId), {
            logs: next.logs,
            activeTimer: next.activeTimer,
            updatedAt: serverTimestamp(),
          }, { merge: true });
        } catch (err) {
          console.error("Firestore write error:", err);
        }
      }, 500);

      return next;
    });
  };

  return [state, updateState, loading];
}

/* ============================================================
   PROGRESS RING
   ============================================================ */
function ProgressRing({ progress, size = 160, stroke = 12, color = "#10b981", track = "#dcfce7", children }) {
  const r = (size - stroke) / 2;
  const C = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(progress, 1));
  const offset = C * (1 - clamped);
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size/2} cy={size/2} r={r} stroke={track} strokeWidth={stroke} fill="none" />
        <circle
          cx={size/2} cy={size/2} r={r}
          stroke={color} strokeWidth={stroke} fill="none"
          strokeDasharray={C} strokeDashoffset={offset} strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 0.6s cubic-bezier(.4,0,.2,1)" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        {children}
      </div>
    </div>
  );
}

/* ============================================================
   PRIMITIVES
   ============================================================ */
function Tile({ label, value, sub, tone = "slate", icon: Icon }) {
  const tones = {
    slate: "bg-slate-50 border-slate-200/70",
    emerald: "bg-emerald-50 border-emerald-200/70",
    amber: "bg-amber-50 border-amber-200/70",
    sky: "bg-sky-50 border-sky-200/70",
    violet: "bg-violet-50 border-violet-200/70",
    rose: "bg-rose-50 border-rose-200/70",
  };
  return (
    <div className={`rounded-2xl border p-4 ${tones[tone]} relative overflow-hidden`}>
      <div className="flex items-start justify-between">
        <div className="text-xs font-medium text-slate-600">{label}</div>
        {Icon && <Icon className="w-4 h-4 text-slate-400" />}
      </div>
      <div className="mt-2 text-2xl font-bold text-slate-900 tracking-tight font-mono">{value}</div>
      {sub && <div className="text-xs text-slate-500 mt-1">{sub}</div>}
    </div>
  );
}

function Pill({ children, tone = "emerald" }) {
  const tones = {
    emerald: "bg-emerald-100 text-emerald-700 border-emerald-200",
    amber: "bg-amber-100 text-amber-700 border-amber-200",
    rose: "bg-rose-100 text-rose-700 border-rose-200",
    slate: "bg-slate-100 text-slate-700 border-slate-200",
    sky: "bg-sky-100 text-sky-700 border-sky-200",
  };
  return (
    <span className={`inline-flex items-center text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-full border ${tones[tone]}`}>
      {children}
    </span>
  );
}

function Modal({ open, onClose, title, children }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-slate-900/40 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h3 className="font-semibold text-slate-900">{title}</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100">
            <X className="w-4 h-4 text-slate-500" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

/* ============================================================
   ANALYTICS HELPERS
   ============================================================ */
function getMonthlyStats(logs, year, month) {
  const totalWorkingDays = workingDaysInMonth(year, month);
  const last = new Date(year, month + 1, 0).getDate();
  let workedDays = 0, leavesTaken = 0, totalMinutes = 0;
  for (let d = 1; d <= last; d++) {
    const k = dateKey(new Date(year, month, d));
    const log = logs[k];
    if (!log) continue;
    if (log.status === "working") {
      workedDays++;
      totalMinutes += log.totalMinutes || 0;
    } else if (log.status === "leave") {
      leavesTaken++;
    }
  }
  const expectedMinutes = totalWorkingDays * TARGET_MINUTES;
  const workedExpected = workedDays * TARGET_MINUTES;
  const surplus = totalMinutes - workedExpected;
  const avgPerDay = workedDays > 0 ? Math.round(totalMinutes / workedDays) : 0;
  return { totalWorkingDays, workedDays, leavesTaken, totalMinutes, expectedMinutes, surplus, avgPerDay };
}

function getFYSurplus(logs, refDate) {
  const start = fyStartFor(refDate);
  const end = fyEndFor(refDate);
  let surplus = 0;
  Object.values(logs).forEach((l) => {
    if (l.status !== "working") return;
    const d = parseKey(l.date);
    if (d < start || d > end) return;
    surplus += (l.totalMinutes || 0) - TARGET_MINUTES;
  });
  return surplus;
}

function getLeavesUsedFY(logs, refDate) {
  const start = fyStartFor(refDate);
  const end = fyEndFor(refDate);
  return Object.values(logs).filter((l) => {
    if (l.status !== "leave") return false;
    const d = parseKey(l.date);
    return d >= start && d <= end;
  }).length;
}

/* ============================================================
   AUTH SCREEN
   ============================================================ */
function AuthScreen() {
  const [mode, setMode] = useState("login"); // "login" | "signup"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleEmailAuth = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      if (mode === "signup") {
        if (!name.trim()) {
          setError("Please enter your name.");
          setLoading(false);
          return;
        }
        const cred = await createUserWithEmailAndPassword(auth, email, password);
        await updateProfile(cred.user, { displayName: name.trim() });
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
    } catch (err) {
      setError(prettifyAuthError(err.code));
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleAuth = async () => {
    setError("");
    setLoading(true);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      setError(prettifyAuthError(err.code));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-stone-50 flex items-center justify-center p-4" style={{ fontFamily: "'Manrope', system-ui, sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;700&display=swap');
        body { font-family: 'Manrope', system-ui, sans-serif; }
        .font-mono { font-family: 'JetBrains Mono', ui-monospace, monospace; font-feature-settings: "tnum"; }
      `}</style>

      <div className="w-full max-w-md">
        {/* Logo + heading */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-emerald-500 grid place-items-center shadow-lg shadow-emerald-500/30 mx-auto mb-4">
            <Clock className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Work Hours Tracker</h1>
          <p className="text-sm text-slate-500 mt-1">
            {mode === "login" ? "Welcome back. Sign in to continue." : "Create an account to get started."}
          </p>
        </div>

        <div className="bg-white rounded-3xl border border-slate-200 p-6 shadow-sm">
          {/* Google button */}
          <button
            onClick={handleGoogleAuth}
            disabled={loading}
            className="w-full flex items-center justify-center gap-3 px-4 py-3 rounded-xl border border-slate-200 hover:bg-slate-50 font-semibold text-sm text-slate-700 transition disabled:opacity-50"
          >
            <GoogleIcon />
            Continue with Google
          </button>

          {/* Divider */}
          <div className="flex items-center gap-3 my-5">
            <div className="flex-1 h-px bg-slate-200" />
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">or</span>
            <div className="flex-1 h-px bg-slate-200" />
          </div>

          {/* Email form */}
          <form onSubmit={handleEmailAuth} className="space-y-3">
            {mode === "signup" && (
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">Full name</label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full pl-10 pr-3 py-3 rounded-xl border border-slate-200 focus:outline-none focus:border-emerald-500 text-sm"
                    placeholder="Your name"
                    required={mode === "signup"}
                  />
                </div>
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">Email</label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full pl-10 pr-3 py-3 rounded-xl border border-slate-200 focus:outline-none focus:border-emerald-500 text-sm"
                  placeholder="you@example.com"
                  required
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">Password</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full pl-10 pr-3 py-3 rounded-xl border border-slate-200 focus:outline-none focus:border-emerald-500 text-sm"
                  placeholder="At least 6 characters"
                  required
                  minLength={6}
                />
              </div>
            </div>

            {error && (
              <div className="rounded-xl bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-semibold text-sm transition disabled:opacity-50"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              {mode === "login" ? "Sign in" : "Create account"}
            </button>
          </form>

          {/* Mode toggle */}
          <p className="text-center text-sm text-slate-500 mt-5">
            {mode === "login" ? "New here? " : "Already have an account? "}
            <button
              onClick={() => { setMode(mode === "login" ? "signup" : "login"); setError(""); }}
              className="font-semibold text-emerald-600 hover:text-emerald-700"
            >
              {mode === "login" ? "Create an account" : "Sign in"}
            </button>
          </p>
        </div>

        <p className="text-center text-xs text-slate-400 mt-5">
          Your data is private and secure. Synced across all your devices.
        </p>
      </div>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18">
      <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"/>
      <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/>
      <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"/>
      <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"/>
    </svg>
  );
}

function prettifyAuthError(code) {
  const map = {
    "auth/email-already-in-use": "An account with this email already exists. Try signing in instead.",
    "auth/invalid-email": "Please enter a valid email address.",
    "auth/weak-password": "Password should be at least 6 characters.",
    "auth/user-not-found": "No account found with this email.",
    "auth/wrong-password": "Incorrect password. Try again.",
    "auth/invalid-credential": "Invalid email or password.",
    "auth/popup-closed-by-user": "Sign-in window was closed.",
    "auth/network-request-failed": "Network error. Check your connection.",
  };
  return map[code] || "Something went wrong. Please try again.";
}

/* ============================================================
   AUTH GATE — Top-level wrapper
   ============================================================ */
export default function App() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthLoading(false);
    });
    return unsub;
  }, []);

  if (authLoading) {
    return (
      <div className="min-h-screen bg-stone-50 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-emerald-500" />
      </div>
    );
  }

  if (!user) return <AuthScreen />;
  return <WorkHoursTracker user={user} />;
}

/* ============================================================
   MAIN TRACKER (logged-in users)
   ============================================================ */
function WorkHoursTracker({ user }) {
  const [state, setState, loadingData] = useFirestoreState(user.uid);
  const [tab, setTab] = useState("dashboard");
  const [now, setNow] = useState(Date.now());
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmCheckout, setConfirmCheckout] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showMigrate, setShowMigrate] = useState(false);

  // Tick every second
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Check for localStorage data to migrate (one-time)
  useEffect(() => {
    if (loadingData) return;
    try {
      const local = localStorage.getItem(LOCAL_KEY);
      if (!local) return;
      const parsed = JSON.parse(local);
      const hasLocalData = (parsed.logs && Object.keys(parsed.logs).length > 0) || parsed.activeTimer;
      const hasCloudData = Object.keys(state.logs || {}).length > 0;
      const dismissed = localStorage.getItem(LOCAL_KEY + "_migrate_dismissed");
      if (hasLocalData && !hasCloudData && !dismissed) {
        setShowMigrate(true);
      }
    } catch {}
  }, [loadingData]);

  const handleMigrate = (action) => {
    if (action === "import") {
      try {
        const local = JSON.parse(localStorage.getItem(LOCAL_KEY));
        setState({
          logs: local.logs || {},
          activeTimer: local.activeTimer || null,
        });
        localStorage.setItem(LOCAL_KEY + "_migrate_dismissed", "1");
      } catch (e) {
        console.error("Migration failed:", e);
      }
    } else {
      localStorage.setItem(LOCAL_KEY + "_migrate_dismissed", "1");
    }
    setShowMigrate(false);
  };

  /* --------- Derived values --------- */
  const today = new Date();
  const tKey = todayKey();
  const todayLog = state.logs[tKey];
  const activeTimer = state.activeTimer;
  const isStaleTimer = activeTimer && activeTimer.date !== tKey;

  const liveTimer = useMemo(() => {
    if (!activeTimer) return null;
    const checkIn = new Date(activeTimer.checkInISO);
    const elapsedMs = now - checkIn.getTime();
    const elapsedSec = Math.max(0, Math.floor(elapsedMs / 1000));
    const elapsedMin = elapsedSec / 60;
    const remainingMin = TARGET_MINUTES - elapsedMin;
    const expectedCheckout = new Date(checkIn.getTime() + TARGET_MINUTES * 60000);
    return { checkIn, elapsedSec, elapsedMin, remainingMin, expectedCheckout };
  }, [activeTimer, now]);

  const fySurplus = useMemo(() => getFYSurplus(state.logs, today), [state.logs]);
  const leavesUsed = useMemo(() => getLeavesUsedFY(state.logs, today), [state.logs]);
  const leavesRemaining = ANNUAL_LEAVES - leavesUsed;

  const monthStats = useMemo(
    () => getMonthlyStats(state.logs, today.getFullYear(), today.getMonth()),
    [state.logs]
  );

  /* --------- Actions --------- */
  const checkInNow = () => {
    const iso = new Date().toISOString();
    setState((s) => ({ ...s, activeTimer: { date: tKey, checkInISO: iso } }));
  };

  const setCheckInTime = (timeStr) => {
    const [h, m] = timeStr.split(":").map(Number);
    if (isNaN(h) || isNaN(m)) return;
    const d = new Date();
    d.setHours(h, m, 0, 0);
    setState((s) => ({ ...s, activeTimer: { date: tKey, checkInISO: d.toISOString() } }));
  };

  const performCheckout = (atDate = new Date(), targetDateKey = tKey) => {
    if (!activeTimer) return;
    const checkIn = new Date(activeTimer.checkInISO);
    const totalMinutes = Math.max(0, Math.round((atDate - checkIn) / 60000));
    setState((s) => ({
      ...s,
      logs: {
        ...s.logs,
        [targetDateKey]: {
          date: targetDateKey,
          status: "working",
          checkIn: activeTimer.checkInISO,
          checkOut: atDate.toISOString(),
          totalMinutes,
        },
      },
      activeTimer: null,
    }));
  };

  const checkOut = () => performCheckout(new Date());

  const resetDay = () => {
    setState((s) => {
      const newLogs = { ...s.logs };
      delete newLogs[tKey];
      return { ...s, logs: newLogs, activeTimer: null };
    });
    setConfirmReset(false);
  };

  const finalizeStaleAt = (mode) => {
    if (!activeTimer) return;
    if (mode === "discard") {
      setState((s) => ({ ...s, activeTimer: null }));
      return;
    }
    const checkIn = new Date(activeTimer.checkInISO);
    const out = new Date(checkIn.getTime() + TARGET_MINUTES * 60000);
    performCheckout(out, activeTimer.date);
  };

  const addLeave = (dateStr) => {
    if (!dateStr) return;
    const d = parseKey(dateStr);
    if (isOff(d)) {
      alert("That day is already off (Sunday or first Saturday).");
      return;
    }
    if (state.logs[dateStr] && state.logs[dateStr].status === "working") {
      alert("That day already has a working log. Reset it first.");
      return;
    }
    if (d < new Date(new Date().setHours(0, 0, 0, 0))) {
      alert("Backfilling past dates is not allowed.");
      return;
    }
    if (leavesRemaining <= 0) {
      alert("No leave balance remaining for this financial year.");
      return;
    }
    setState((s) => ({
      ...s,
      logs: {
        ...s.logs,
        [dateStr]: { date: dateStr, status: "leave" },
      },
    }));
  };

  const removeLeave = (dateStr) => {
    setState((s) => {
      const newLogs = { ...s.logs };
      delete newLogs[dateStr];
      return { ...s, logs: newLogs };
    });
  };

  const exportCSV = () => {
    const rows = [["Date", "Day", "Status", "Check-in", "Check-out", "Total Hours", "vs Target (min)"]];
    const sorted = Object.values(state.logs).sort((a, b) => a.date.localeCompare(b.date));
    sorted.forEach((l) => {
      const d = parseKey(l.date);
      const days = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
      rows.push([
        l.date,
        days[d.getDay()],
        l.status,
        l.checkIn ? formatTime12(l.checkIn) : "",
        l.checkOut ? formatTime12(l.checkOut) : "",
        l.totalMinutes != null ? formatHMNoSign(l.totalMinutes) : "",
        l.status === "working" ? (l.totalMinutes - TARGET_MINUTES) : "",
      ]);
    });
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `work-tracker-${todayKey()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleSignOut = async () => {
    await signOut(auth);
  };

  /* --------- Today status --------- */
  const todayKind = dayKind(today);
  let todayState;
  if (todayKind === "sunday") todayState = "off-sunday";
  else if (todayKind === "first-sat") todayState = "off-firstsat";
  else if (todayLog && todayLog.status === "leave") todayState = "leave";
  else if (todayLog && todayLog.status === "working") todayState = "completed";
  else if (activeTimer && activeTimer.date === tKey) todayState = "working";
  else todayState = "not-started";

  // Loading state
  if (loadingData) {
    return (
      <div className="min-h-screen bg-stone-50 flex flex-col items-center justify-center gap-3">
        <Loader2 className="w-8 h-8 animate-spin text-emerald-500" />
        <p className="text-sm text-slate-500 font-medium">Syncing your data...</p>
      </div>
    );
  }

  const userInitial = (user.displayName || user.email || "?").charAt(0).toUpperCase();

  return (
    <div className="min-h-screen bg-stone-50 text-slate-900">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;700&display=swap');
        .font-sans, body { font-family: 'Manrope', system-ui, sans-serif; }
        .font-mono { font-family: 'JetBrains Mono', ui-monospace, monospace; font-feature-settings: "tnum"; }
        * { -webkit-tap-highlight-color: transparent; }
      `}</style>

      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-5 sm:py-7" style={{ fontFamily: "'Manrope', system-ui, sans-serif" }}>

        {/* HEADER */}
        <header className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-emerald-500 grid place-items-center shadow-md shadow-emerald-500/30">
              <Clock className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg sm:text-xl font-bold tracking-tight">Work Hours Tracker</h1>
              <p className="text-xs text-slate-500 font-medium">{longDate(today)}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={exportCSV}
              className="hidden sm:flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-200 hover:bg-slate-50 text-sm font-medium text-slate-700"
            >
              <Download className="w-4 h-4" /> Export
            </button>
            <button
              onClick={() => setShowProfile(true)}
              className="w-10 h-10 rounded-full bg-slate-200 hover:bg-slate-300 grid place-items-center font-bold text-slate-700 transition overflow-hidden"
            >
              {user.photoURL ? (
                <img src={user.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
              ) : (
                userInitial
              )}
            </button>
          </div>
        </header>

        {/* TABS */}
        <nav className="flex items-center gap-1 mb-6 overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
          {[
            { id: "dashboard", label: "Dashboard", icon: Home },
            { id: "calendar", label: "Calendar", icon: CalendarIcon },
            { id: "leaves", label: "Leaves", icon: Palmtree },
            { id: "history", label: "History", icon: HistoryIcon },
            { id: "analytics", label: "Analytics", icon: BarChart3 },
          ].map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold whitespace-nowrap transition ${
                tab === id ? "bg-slate-900 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              <Icon className="w-4 h-4" />
              {label}
            </button>
          ))}
        </nav>

        {/* STALE TIMER BANNER */}
        {isStaleTimer && (
          <div className="mb-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-amber-600 mt-0.5 shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-amber-900">
                Unfinished session from {shortDate(parseKey(activeTimer.date))}
              </p>
              <p className="text-xs text-amber-700 mt-0.5">
                Checked in at {formatTime12(activeTimer.checkInISO)}. Finalize it to continue.
              </p>
              <div className="flex gap-2 mt-3">
                <button
                  onClick={() => finalizeStaleAt("complete-target")}
                  className="px-3 py-1.5 rounded-lg bg-amber-600 text-white text-xs font-semibold hover:bg-amber-700"
                >
                  Mark complete (8h 30m)
                </button>
                <button
                  onClick={() => finalizeStaleAt("discard")}
                  className="px-3 py-1.5 rounded-lg bg-white border border-amber-300 text-amber-800 text-xs font-semibold hover:bg-amber-100"
                >
                  Discard
                </button>
              </div>
            </div>
          </div>
        )}

        {/* VIEWS */}
        {tab === "dashboard" && (
          <DashboardView
            today={today}
            todayState={todayState}
            todayLog={todayLog}
            activeTimer={activeTimer}
            liveTimer={liveTimer}
            monthStats={monthStats}
            leavesUsed={leavesUsed}
            leavesRemaining={leavesRemaining}
            fySurplus={fySurplus}
            logs={state.logs}
            checkInNow={checkInNow}
            setCheckInTime={setCheckInTime}
            checkOut={() => setConfirmCheckout(true)}
            resetDay={() => setConfirmReset(true)}
            goToLeaves={() => setTab("leaves")}
            goToHistory={() => setTab("history")}
          />
        )}
        {tab === "calendar" && <CalendarView logs={state.logs} todayKey={tKey} />}
        {tab === "leaves" && <LeavesView logs={state.logs} leavesUsed={leavesUsed} leavesRemaining={leavesRemaining} addLeave={addLeave} removeLeave={removeLeave} />}
        {tab === "history" && <HistoryView logs={state.logs} exportCSV={exportCSV} />}
        {tab === "analytics" && <AnalyticsView logs={state.logs} fySurplus={fySurplus} />}

        {/* FOOTER */}
        <footer className="mt-10 pt-6 border-t border-slate-200 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs text-slate-500">
          <div className="flex items-center gap-2">
            <Sparkles className="w-3.5 h-3.5 text-amber-500" />
            <span>Synced to cloud · {fyLabel(today)}</span>
          </div>
          <span>Signed in as {user.displayName || user.email}</span>
        </footer>

        {/* PROFILE MODAL */}
        <Modal open={showProfile} onClose={() => setShowProfile(false)} title="Your account">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-14 h-14 rounded-full bg-emerald-100 grid place-items-center font-bold text-emerald-700 text-xl overflow-hidden">
              {user.photoURL ? (
                <img src={user.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
              ) : userInitial}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-slate-900 truncate">{user.displayName || "User"}</p>
              <p className="text-xs text-slate-500 truncate">{user.email}</p>
            </div>
          </div>
          <button
            onClick={exportCSV}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-slate-200 hover:bg-slate-50 font-semibold text-sm mb-2"
          >
            <Download className="w-4 h-4" /> Export your data (CSV)
          </button>
          <button
            onClick={handleSignOut}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-semibold text-sm"
          >
            <LogOut className="w-4 h-4" /> Sign out
          </button>
        </Modal>

        {/* MIGRATION MODAL */}
        <Modal open={showMigrate} onClose={() => handleMigrate("dismiss")} title="Import existing data?">
          <p className="text-sm text-slate-600 mb-4">
            We found work tracking data on this device that isn't synced to your account yet.
            Do you want to import it now? You can only do this once.
          </p>
          <div className="flex gap-2">
            <button onClick={() => handleMigrate("dismiss")} className="flex-1 px-4 py-2.5 rounded-xl border border-slate-200 font-semibold text-sm">
              Skip
            </button>
            <button onClick={() => handleMigrate("import")} className="flex-1 px-4 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white font-semibold text-sm">
              Import to my account
            </button>
          </div>
        </Modal>

        {/* RESET / CHECKOUT MODALS */}
        <Modal open={confirmReset} onClose={() => setConfirmReset(false)} title="Reset today?">
          <p className="text-sm text-slate-600">This clears today's check-in, check-out and total hours. This action can't be undone.</p>
          <div className="flex gap-2 mt-5">
            <button onClick={() => setConfirmReset(false)} className="flex-1 px-4 py-2.5 rounded-xl border border-slate-200 font-semibold text-sm">Cancel</button>
            <button onClick={resetDay} className="flex-1 px-4 py-2.5 rounded-xl bg-rose-500 text-white font-semibold text-sm hover:bg-rose-600">Reset</button>
          </div>
        </Modal>

        <Modal open={confirmCheckout} onClose={() => setConfirmCheckout(false)} title="Check out now?">
          {liveTimer && (
            <div className="text-sm text-slate-600">
              <p>You'll log <span className="font-bold text-slate-900">{formatHMNoSign(liveTimer.elapsedMin)}</span> for today.</p>
              {liveTimer.elapsedMin < TARGET_MINUTES && (
                <p className="mt-2 text-rose-600 font-medium">
                  Deficit of {formatHMNoSign(TARGET_MINUTES - liveTimer.elapsedMin)} vs 8h 30m target.
                </p>
              )}
              {liveTimer.elapsedMin > TARGET_MINUTES && (
                <p className="mt-2 text-emerald-600 font-medium">
                  Surplus of {formatHMNoSign(liveTimer.elapsedMin - TARGET_MINUTES)} above target.
                </p>
              )}
            </div>
          )}
          <div className="flex gap-2 mt-5">
            <button onClick={() => setConfirmCheckout(false)} className="flex-1 px-4 py-2.5 rounded-xl border border-slate-200 font-semibold text-sm">Cancel</button>
            <button onClick={() => { checkOut(); setConfirmCheckout(false); }} className="flex-1 px-4 py-2.5 rounded-xl bg-slate-900 text-white font-semibold text-sm hover:bg-slate-800">Check out</button>
          </div>
        </Modal>
      </div>
    </div>
  );
}

/* ============================================================
   DASHBOARD VIEW
   ============================================================ */
function DashboardView({
  today, todayState, todayLog, activeTimer, liveTimer,
  monthStats, leavesUsed, leavesRemaining, fySurplus, logs,
  checkInNow, setCheckInTime, checkOut, resetDay,
  goToLeaves, goToHistory,
}) {
  const [showCheckinPicker, setShowCheckinPicker] = useState(false);
  const [manualTime, setManualTime] = useState(() => {
    const d = new Date();
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });

  const recent = useMemo(() => {
    const arr = Object.values(logs).filter((l) => l.date !== todayKey()).sort((a, b) => b.date.localeCompare(a.date));
    return arr.slice(0, 5);
  }, [logs]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
      <div className="lg:col-span-2 space-y-5">
        <TimerCard
          today={today}
          todayState={todayState}
          todayLog={todayLog}
          liveTimer={liveTimer}
          checkInNow={checkInNow}
          setCheckInTime={setCheckInTime}
          checkOut={checkOut}
          resetDay={resetDay}
          showCheckinPicker={showCheckinPicker}
          setShowCheckinPicker={setShowCheckinPicker}
          manualTime={manualTime}
          setManualTime={setManualTime}
        />

        <section className="rounded-3xl bg-white border border-slate-200 p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="font-bold text-slate-900">Monthly Summary</h2>
              <p className="text-xs text-slate-500 mt-0.5">{monthLabel(today.getFullYear(), today.getMonth())}</p>
            </div>
            <button onClick={goToHistory} className="text-xs font-semibold text-emerald-600 hover:text-emerald-700">
              View all →
            </button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Tile label="Working Days" value={monthStats.totalWorkingDays} sub="this month" tone="sky" icon={CalendarIcon} />
            <Tile label="Days Worked" value={monthStats.workedDays} sub={`of ${monthStats.totalWorkingDays}`} tone="emerald" icon={CheckCircle2} />
            <Tile label="Leaves Taken" value={monthStats.leavesTaken} sub="this month" tone="amber" icon={Palmtree} />
            <Tile label="Total Hours" value={formatHMNoSign(monthStats.totalMinutes)} sub={`avg ${formatHMNoSign(monthStats.avgPerDay)}/day`} tone="violet" icon={Clock} />
          </div>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="rounded-2xl border border-slate-200 p-4 flex items-center justify-between">
              <div>
                <div className="text-xs font-medium text-slate-500">Expected Hours</div>
                <div className="font-mono font-bold text-lg mt-1">{formatHMNoSign(monthStats.expectedMinutes)}</div>
              </div>
              <Clock className="w-5 h-5 text-slate-300" />
            </div>
            <div className={`rounded-2xl border p-4 flex items-center justify-between ${monthStats.surplus >= 0 ? "border-emerald-200 bg-emerald-50/50" : "border-rose-200 bg-rose-50/50"}`}>
              <div>
                <div className="text-xs font-medium text-slate-500">Surplus / Deficit (Month)</div>
                <div className={`font-mono font-bold text-lg mt-1 ${monthStats.surplus >= 0 ? "text-emerald-700" : "text-rose-700"}`}>
                  {formatHM(monthStats.surplus)}
                </div>
              </div>
              <TrendingUp className={`w-5 h-5 ${monthStats.surplus >= 0 ? "text-emerald-400" : "text-rose-400"}`} />
            </div>
          </div>
        </section>

        <section className="rounded-3xl bg-white border border-slate-200 p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-bold text-slate-900">Recent Days</h2>
            <button onClick={goToHistory} className="text-xs font-semibold text-emerald-600 hover:text-emerald-700">
              View all →
            </button>
          </div>
          {recent.length === 0 ? (
            <p className="text-sm text-slate-500 py-6 text-center">No history yet. Start tracking today!</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {recent.map((l) => <RecentRow key={l.date} log={l} />)}
            </ul>
          )}
        </section>
      </div>

      <div className="space-y-5">
        <section className="rounded-3xl bg-white border border-slate-200 p-5">
          <div className="flex items-start justify-between mb-1">
            <div>
              <h2 className="font-bold text-slate-900">Leave Balance</h2>
              <p className="text-xs text-slate-500 mt-0.5">{fyLabel(today)}</p>
            </div>
          </div>
          <div className="flex justify-center my-4">
            <ProgressRing progress={leavesUsed / ANNUAL_LEAVES} size={170} stroke={14} color="#8b5cf6" track="#f3e8ff">
              <div className="text-xs font-medium text-slate-500">Leaves Used</div>
              <div className="text-4xl font-bold font-mono text-slate-900 mt-1">{leavesUsed}</div>
              <div className="text-xs text-slate-400 mt-0.5">of {ANNUAL_LEAVES}</div>
            </ProgressRing>
          </div>
          <div className="text-center mb-4">
            <p className="text-xs font-medium text-slate-500">Remaining</p>
            <p className="text-3xl font-bold text-slate-900 font-mono">{leavesRemaining}</p>
          </div>
          <button
            onClick={goToLeaves}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-emerald-500 text-white font-semibold text-sm hover:bg-emerald-600 transition shadow-sm shadow-emerald-500/30"
          >
            <Plus className="w-4 h-4" /> Add Leave
          </button>
        </section>

        <section className={`rounded-3xl p-5 border ${fySurplus >= 0 ? "bg-gradient-to-br from-emerald-500 to-emerald-600 border-emerald-600" : "bg-gradient-to-br from-rose-500 to-rose-600 border-rose-600"} text-white shadow-lg`}>
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-bold uppercase tracking-wider opacity-90">Carry-Forward Balance</p>
            <TrendingUp className="w-4 h-4 opacity-80" />
          </div>
          <p className="text-4xl font-bold font-mono tracking-tight">{formatHM(fySurplus)}</p>
          <p className="text-xs mt-2 opacity-90 leading-relaxed">
            {fySurplus >= 0
              ? `You have ${formatHMNoSign(fySurplus)} of credit accumulated this financial year.`
              : `You're behind by ${formatHMNoSign(Math.abs(fySurplus))} this financial year.`}
          </p>
        </section>
      </div>
    </div>
  );
}

/* ============================================================
   TIMER CARD
   ============================================================ */
function TimerCard({
  today, todayState, todayLog, liveTimer,
  checkInNow, setCheckInTime, checkOut, resetDay,
  showCheckinPicker, setShowCheckinPicker, manualTime, setManualTime,
}) {
  if (todayState === "off-sunday" || todayState === "off-firstsat") {
    return (
      <section className="rounded-3xl bg-gradient-to-br from-slate-100 to-slate-50 border border-slate-200 p-6">
        <div className="flex items-center gap-2 mb-3"><Pill tone="slate">Off Day</Pill></div>
        <h2 className="text-2xl font-bold text-slate-900">
          {todayState === "off-sunday" ? "Sunday off" : "First Saturday off"}
        </h2>
        <p className="text-sm text-slate-500 mt-1">No work expected today. Recharge.</p>
      </section>
    );
  }

  if (todayState === "leave") {
    return (
      <section className="rounded-3xl bg-gradient-to-br from-amber-50 to-yellow-50 border border-amber-200 p-6">
        <div className="flex items-center gap-2 mb-3"><Pill tone="amber">On Leave</Pill></div>
        <h2 className="text-2xl font-bold text-slate-900">Enjoy your day off</h2>
        <p className="text-sm text-slate-500 mt-1">Today is marked as leave from your annual quota.</p>
      </section>
    );
  }

  if (todayState === "completed") {
    const total = todayLog.totalMinutes;
    const surplus = total - TARGET_MINUTES;
    return (
      <section className="rounded-3xl bg-gradient-to-br from-emerald-50 to-emerald-100/40 border border-emerald-200 p-6">
        <div className="flex items-center justify-between mb-4">
          <Pill tone="emerald">Day Complete</Pill>
          <button onClick={resetDay} className="text-xs font-semibold text-slate-600 hover:text-slate-900">Reset Day</button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-6 items-center">
          <div>
            <p className="text-xs font-medium text-slate-500 mb-1">You worked</p>
            <p className="text-5xl font-bold font-mono text-emerald-700 tracking-tight">{formatHMNoSign(total)}</p>
            <p className={`text-sm font-semibold mt-2 ${surplus >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
              {surplus >= 0 ? `+${formatHMNoSign(surplus)} surplus` : `${formatHMNoSign(Math.abs(surplus))} deficit`}
            </p>
          </div>
          <div className="flex justify-center">
            <ProgressRing progress={Math.min(total / TARGET_MINUTES, 1)} size={150} stroke={12} color="#10b981" track="#dcfce7">
              <CheckCircle2 className="w-10 h-10 text-emerald-500" />
            </ProgressRing>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 mt-5 pt-5 border-t border-emerald-200">
          <div>
            <p className="text-xs text-slate-500">Check-in</p>
            <p className="font-semibold text-slate-900">{formatTime12(todayLog.checkIn)}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">Check-out</p>
            <p className="font-semibold text-slate-900">{formatTime12(todayLog.checkOut)}</p>
          </div>
        </div>
      </section>
    );
  }

  if (todayState === "working") {
    const { elapsedSec, elapsedMin, remainingMin, expectedCheckout, checkIn } = liveTimer;
    const progress = Math.min(elapsedMin / TARGET_MINUTES, 1);
    const isSurplus = elapsedMin >= TARGET_MINUTES;
    const surplusMin = elapsedMin - TARGET_MINUTES;

    return (
      <section className="rounded-3xl bg-gradient-to-br from-emerald-50 via-emerald-50/60 to-white border border-emerald-200 p-6">
        <div className="flex items-center justify-between mb-5">
          <Pill tone="emerald">Working</Pill>
          <span className="text-xs font-medium text-slate-500">{longDate(today)}</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-6 items-center">
          <div>
            <p className="text-xs font-medium text-slate-500 mb-1">
              {isSurplus ? "Surplus Time" : "Time Remaining"}
            </p>
            <p className={`text-5xl sm:text-6xl font-bold font-mono tracking-tight ${isSurplus ? "text-emerald-600" : "text-emerald-700"}`}>
              {isSurplus ? `+${formatHMS(surplusMin * 60)}` : formatHMS(remainingMin * 60)}
            </p>
            <p className="text-xs text-slate-500 mt-2">( 8h 30m daily target )</p>
          </div>

          <div className="flex justify-center">
            <ProgressRing progress={progress} size={170} stroke={14} color={isSurplus ? "#059669" : "#10b981"} track="#dcfce7">
              <div className="text-xs font-medium text-slate-500">Worked</div>
              <div className="text-2xl font-bold font-mono text-slate-900 mt-1">{formatHMS(elapsedSec)}</div>
              <div className="text-[10px] text-slate-400 mt-0.5">of 8h 30m</div>
            </ProgressRing>
          </div>
        </div>

        <div className="mt-6 space-y-3">
          <div className="flex items-center justify-between py-2 border-t border-emerald-200/60">
            <span className="text-sm text-slate-600">Check-in Time</span>
            <span className="font-semibold text-slate-900 font-mono text-sm">{formatTime12(checkIn)}</span>
          </div>
          <div className="flex items-center justify-between py-2 border-t border-emerald-200/60">
            <span className="text-sm text-slate-600">Expected Check-out</span>
            <span className="font-semibold text-slate-900 font-mono text-sm">{formatTime12(expectedCheckout)}</span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 mt-5">
          <button
            onClick={checkOut}
            className={`px-4 py-3 rounded-xl font-semibold text-sm shadow-sm transition ${isSurplus ? "bg-emerald-500 hover:bg-emerald-600 text-white" : "bg-rose-500 hover:bg-rose-600 text-white"}`}
          >
            {isSurplus ? "Check Out" : "Check-out Early"}
          </button>
          <button
            onClick={resetDay}
            className="px-4 py-3 rounded-xl border border-slate-200 bg-white font-semibold text-sm text-slate-700 hover:bg-slate-50"
          >
            Reset Day
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-3xl bg-gradient-to-br from-slate-50 to-white border border-slate-200 p-6">
      <div className="flex items-center justify-between mb-4">
        <Pill tone="slate">Not Checked In</Pill>
        <span className="text-xs font-medium text-slate-500">{longDate(today)}</span>
      </div>
      <h2 className="text-2xl font-bold text-slate-900">Ready to start your day?</h2>
      <p className="text-sm text-slate-500 mt-1 mb-6">Check in to begin tracking. Target: 8h 30m.</p>

      {showCheckinPicker ? (
        <div className="space-y-3">
          <label className="block text-xs font-semibold text-slate-700">Check-in time</label>
          <input
            type="time"
            value={manualTime}
            onChange={(e) => setManualTime(e.target.value)}
            className="w-full px-4 py-3 rounded-xl border border-slate-200 font-mono text-lg focus:outline-none focus:border-emerald-500"
          />
          <div className="grid grid-cols-2 gap-3">
            <button onClick={() => setShowCheckinPicker(false)} className="px-4 py-3 rounded-xl border border-slate-200 font-semibold text-sm">Cancel</button>
            <button onClick={() => { setCheckInTime(manualTime); setShowCheckinPicker(false); }} className="px-4 py-3 rounded-xl bg-slate-900 text-white font-semibold text-sm">Confirm</button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <button
            onClick={checkInNow}
            className="px-4 py-3.5 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white font-semibold text-sm shadow-sm shadow-emerald-500/30 transition"
          >
            Check-in Now
          </button>
          <button
            onClick={() => setShowCheckinPicker(true)}
            className="px-4 py-3.5 rounded-xl border border-slate-200 bg-white font-semibold text-sm text-slate-700 hover:bg-slate-50"
          >
            Set Check-in Time
          </button>
        </div>
      )}
    </section>
  );
}

/* ============================================================
   RECENT ROW
   ============================================================ */
function RecentRow({ log }) {
  const d = parseKey(log.date);
  if (log.status === "leave") {
    return (
      <li className="flex items-center justify-between py-3">
        <div>
          <p className="font-semibold text-sm text-slate-900">{shortDate(d)}</p>
          <p className="text-xs text-slate-500 mt-0.5">Leave taken</p>
        </div>
        <Pill tone="amber">Leave</Pill>
      </li>
    );
  }
  const surplus = log.totalMinutes - TARGET_MINUTES;
  return (
    <li className="flex items-center justify-between py-3">
      <div>
        <p className="font-semibold text-sm text-slate-900">{shortDate(d)}</p>
        <p className="text-xs text-slate-500 mt-0.5 font-mono">
          {formatTime12(log.checkIn)} – {formatTime12(log.checkOut)}
        </p>
      </div>
      <div className="text-right">
        <p className="font-mono font-bold text-sm text-slate-900">{formatHMNoSign(log.totalMinutes)}</p>
        <p className={`text-xs font-semibold ${surplus >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
          {surplus >= 0 ? `+${formatHMNoSign(surplus)}` : `−${formatHMNoSign(Math.abs(surplus))}`}
        </p>
      </div>
    </li>
  );
}

/* ============================================================
   CALENDAR VIEW
   ============================================================ */
function CalendarView({ logs, todayKey: tKey }) {
  const [cursor, setCursor] = useState(() => {
    const t = new Date();
    return { year: t.getFullYear(), month: t.getMonth() };
  });
  const today = new Date();
  const { year, month } = cursor;
  const firstDay = new Date(year, month, 1);
  const startOffset = (firstDay.getDay() + 6) % 7;
  const lastDay = new Date(year, month + 1, 0).getDate();

  const cells = [];
  const prevLast = new Date(year, month, 0).getDate();
  for (let i = startOffset - 1; i >= 0; i--) {
    cells.push({ day: prevLast - i, inMonth: false, date: new Date(year, month - 1, prevLast - i) });
  }
  for (let d = 1; d <= lastDay; d++) {
    cells.push({ day: d, inMonth: true, date: new Date(year, month, d) });
  }
  while (cells.length % 7 !== 0 || cells.length < 42) {
    const idx = cells.length - lastDay - startOffset + 1;
    cells.push({ day: idx, inMonth: false, date: new Date(year, month + 1, idx) });
    if (cells.length >= 42) break;
  }

  const monthStats = useMemo(() => getMonthlyStats(logs, year, month), [logs, year, month]);

  const navigate = (delta) => {
    const nm = month + delta;
    if (nm < 0) setCursor({ year: year - 1, month: 11 });
    else if (nm > 11) setCursor({ year: year + 1, month: 0 });
    else setCursor({ year, month: nm });
  };

  const goToToday = () => setCursor({ year: today.getFullYear(), month: today.getMonth() });

  return (
    <div className="space-y-5">
      <div className="rounded-3xl bg-white border border-slate-200 p-5">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2">
            <button onClick={() => navigate(-1)} className="p-2 rounded-lg hover:bg-slate-100"><ChevronLeft className="w-4 h-4" /></button>
            <h2 className="font-bold text-slate-900 min-w-[140px] text-center">{monthLabel(year, month)}</h2>
            <button onClick={() => navigate(1)} className="p-2 rounded-lg hover:bg-slate-100"><ChevronRight className="w-4 h-4" /></button>
          </div>
          <button onClick={goToToday} className="px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-600 hover:bg-slate-100">Today</button>
        </div>

        <div className="grid grid-cols-7 mb-2">
          {["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map((d) => (
            <div key={d} className="text-center text-[11px] font-bold uppercase tracking-wider text-slate-400 py-2">{d}</div>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-1.5">
          {cells.map((c, i) => {
            const k = dateKey(c.date);
            const log = logs[k];
            const kind = dayKind(c.date);
            const isToday = k === tKey;

            let bg = "bg-white border-slate-100";
            let textColor = "text-slate-700";
            let label = null;

            if (!c.inMonth) { bg = "bg-transparent border-transparent"; textColor = "text-slate-300"; }
            else if (log?.status === "leave") { bg = "bg-amber-100 border-amber-200"; textColor = "text-amber-800"; label = "L"; }
            else if (log?.status === "working") {
              const surplus = log.totalMinutes - TARGET_MINUTES;
              if (surplus >= 0) { bg = "bg-emerald-100 border-emerald-200"; textColor = "text-emerald-800"; }
              else { bg = "bg-rose-100 border-rose-200"; textColor = "text-rose-800"; }
            }
            else if (kind === "sunday") { bg = "bg-rose-50/40 border-rose-100"; textColor = "text-rose-400"; }
            else if (kind === "first-sat") { bg = "bg-amber-50/40 border-amber-100"; textColor = "text-amber-500"; }

            return (
              <div
                key={i}
                className={`aspect-square rounded-xl border ${bg} ${textColor} flex flex-col items-center justify-center text-sm font-semibold relative ${isToday ? "ring-2 ring-slate-900 ring-offset-1" : ""}`}
              >
                <span>{c.day}</span>
                {label && <span className="text-[9px] absolute bottom-1 font-bold">{label}</span>}
              </div>
            );
          })}
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-2 mt-5 pt-4 border-t border-slate-100 text-xs text-slate-600">
          <LegendDot color="bg-emerald-400" label="Worked (target met)" />
          <LegendDot color="bg-rose-400" label="Worked (deficit)" />
          <LegendDot color="bg-amber-300" label="Leave" />
          <LegendDot color="bg-rose-200" label="Sunday" />
          <LegendDot color="bg-amber-200" label="1st Saturday" />
        </div>
      </div>

      <div className="rounded-3xl bg-white border border-slate-200 p-5">
        <h3 className="font-bold text-slate-900 mb-3">Summary · {monthLabel(year, month)}</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Tile label="Working Days" value={monthStats.totalWorkingDays} tone="sky" />
          <Tile label="Worked" value={monthStats.workedDays} tone="emerald" />
          <Tile label="Leaves" value={monthStats.leavesTaken} tone="amber" />
          <Tile label="Total Hours" value={formatHMNoSign(monthStats.totalMinutes)} tone="violet" />
        </div>
      </div>
    </div>
  );
}

function LegendDot({ color, label }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`w-2.5 h-2.5 rounded-full ${color}`}></span>
      <span>{label}</span>
    </div>
  );
}

/* ============================================================
   LEAVES VIEW
   ============================================================ */
function LeavesView({ logs, leavesUsed, leavesRemaining, addLeave, removeLeave }) {
  const today = new Date();
  const [pickDate, setPickDate] = useState(todayKey());

  const fyStart = fyStartFor(today);
  const fyEnd = fyEndFor(today);

  const leaves = useMemo(() => {
    return Object.values(logs)
      .filter((l) => l.status === "leave")
      .filter((l) => {
        const d = parseKey(l.date);
        return d >= fyStart && d <= fyEnd;
      })
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [logs]);

  const upcoming = leaves.filter((l) => parseKey(l.date) >= new Date(new Date().setHours(0,0,0,0)));
  const past = leaves.filter((l) => parseKey(l.date) < new Date(new Date().setHours(0,0,0,0)));

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
      <section className="lg:col-span-1 space-y-5">
        <div className="rounded-3xl bg-white border border-slate-200 p-5">
          <h2 className="font-bold text-slate-900">Leave Balance</h2>
          <p className="text-xs text-slate-500 mt-0.5">{fyLabel(today)}</p>
          <div className="flex justify-center my-5">
            <ProgressRing progress={leavesUsed / ANNUAL_LEAVES} size={180} stroke={14} color="#8b5cf6" track="#f3e8ff">
              <div className="text-xs font-medium text-slate-500">Used</div>
              <div className="text-4xl font-bold font-mono">{leavesUsed}</div>
              <div className="text-xs text-slate-400">of {ANNUAL_LEAVES}</div>
            </ProgressRing>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="text-center p-3 rounded-xl bg-slate-50">
              <p className="text-xs text-slate-500">Remaining</p>
              <p className="text-2xl font-bold font-mono text-emerald-600">{leavesRemaining}</p>
            </div>
            <div className="text-center p-3 rounded-xl bg-slate-50">
              <p className="text-xs text-slate-500">Used</p>
              <p className="text-2xl font-bold font-mono text-violet-600">{leavesUsed}</p>
            </div>
          </div>
        </div>

        <div className="rounded-3xl bg-white border border-slate-200 p-5">
          <h3 className="font-bold text-slate-900 mb-4">Add Leave</h3>
          <label className="block text-xs font-semibold text-slate-700 mb-2">Select date</label>
          <input
            type="date"
            value={pickDate}
            min={todayKey()}
            onChange={(e) => setPickDate(e.target.value)}
            className="w-full px-4 py-3 rounded-xl border border-slate-200 font-mono focus:outline-none focus:border-emerald-500"
          />
          <button
            onClick={() => addLeave(pickDate)}
            className="w-full mt-3 px-4 py-3 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white font-semibold text-sm shadow-sm shadow-emerald-500/30 flex items-center justify-center gap-2"
          >
            <Plus className="w-4 h-4" /> Mark as leave
          </button>
          <p className="text-[11px] text-slate-500 mt-3 leading-relaxed">
            Leaves can't be applied on Sundays, the first Saturday, or in the past.
          </p>
        </div>
      </section>

      <section className="lg:col-span-2 space-y-5">
        <div className="rounded-3xl bg-white border border-slate-200 p-5">
          <h3 className="font-bold text-slate-900 mb-3">Upcoming Leaves</h3>
          {upcoming.length === 0 ? (
            <p className="text-sm text-slate-500 py-6 text-center">No upcoming leaves planned.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {upcoming.map((l) => (
                <li key={l.date} className="flex items-center justify-between py-3">
                  <div>
                    <p className="font-semibold text-sm text-slate-900">{shortDate(parseKey(l.date))}</p>
                    <p className="text-xs text-slate-500 mt-0.5">Leave</p>
                  </div>
                  <button onClick={() => removeLeave(l.date)} className="p-2 rounded-lg hover:bg-rose-50 text-rose-500" title="Cancel leave">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-3xl bg-white border border-slate-200 p-5">
          <h3 className="font-bold text-slate-900 mb-3">Leaves Taken</h3>
          {past.length === 0 ? (
            <p className="text-sm text-slate-500 py-6 text-center">None yet this financial year.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {past.map((l) => (
                <li key={l.date} className="flex items-center justify-between py-3">
                  <div>
                    <p className="font-semibold text-sm text-slate-900">{shortDate(parseKey(l.date))}</p>
                  </div>
                  <Pill tone="amber">Used</Pill>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

/* ============================================================
   HISTORY VIEW
   ============================================================ */
function HistoryView({ logs, exportCSV }) {
  const sorted = useMemo(
    () => Object.values(logs).sort((a, b) => b.date.localeCompare(a.date)),
    [logs]
  );

  return (
    <div className="rounded-3xl bg-white border border-slate-200 p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-bold text-slate-900">Full History</h2>
        <button onClick={exportCSV} className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-xs font-semibold">
          <Download className="w-3.5 h-3.5" /> Export CSV
        </button>
      </div>

      {sorted.length === 0 ? (
        <p className="text-sm text-slate-500 py-12 text-center">No entries yet.</p>
      ) : (
        <>
          <div className="sm:hidden divide-y divide-slate-100">
            {sorted.map((l) => <RecentRow key={l.date} log={l} />)}
          </div>

          <div className="hidden sm:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs font-bold uppercase tracking-wider text-slate-400 border-b border-slate-200">
                  <th className="py-3 pr-4">Date</th>
                  <th className="py-3 pr-4">Status</th>
                  <th className="py-3 pr-4">Check-in</th>
                  <th className="py-3 pr-4">Check-out</th>
                  <th className="py-3 pr-4 text-right">Total</th>
                  <th className="py-3 pr-4 text-right">Δ vs target</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {sorted.map((l) => {
                  const d = parseKey(l.date);
                  const surplus = l.status === "working" ? l.totalMinutes - TARGET_MINUTES : null;
                  return (
                    <tr key={l.date}>
                      <td className="py-3 pr-4 font-medium text-slate-900">{shortDate(d)}</td>
                      <td className="py-3 pr-4">
                        {l.status === "leave" ? <Pill tone="amber">Leave</Pill> : <Pill tone="emerald">Working</Pill>}
                      </td>
                      <td className="py-3 pr-4 font-mono text-slate-600">{l.checkIn ? formatTime12(l.checkIn) : "–"}</td>
                      <td className="py-3 pr-4 font-mono text-slate-600">{l.checkOut ? formatTime12(l.checkOut) : "–"}</td>
                      <td className="py-3 pr-4 text-right font-mono font-semibold">{l.totalMinutes != null ? formatHMNoSign(l.totalMinutes) : "–"}</td>
                      <td className={`py-3 pr-4 text-right font-mono font-semibold ${surplus == null ? "text-slate-400" : surplus >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                        {surplus == null ? "–" : formatHM(surplus)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/* ============================================================
   ANALYTICS VIEW
   ============================================================ */
function AnalyticsView({ logs, fySurplus }) {
  const today = new Date();

  const months = useMemo(() => {
    const arr = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const stats = getMonthlyStats(logs, d.getFullYear(), d.getMonth());
      arr.push({
        label: ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getMonth()] + " " + String(d.getFullYear()).slice(-2),
        ...stats,
      });
    }
    return arr;
  }, [logs]);

  const maxHours = Math.max(...months.map((m) => Math.max(m.totalMinutes, m.expectedMinutes)), TARGET_MINUTES);

  return (
    <div className="space-y-5">
      <div className={`rounded-3xl p-6 border ${fySurplus >= 0 ? "bg-gradient-to-br from-emerald-500 to-emerald-600 border-emerald-600" : "bg-gradient-to-br from-rose-500 to-rose-600 border-rose-600"} text-white`}>
        <p className="text-xs font-bold uppercase tracking-wider opacity-90">FY Carry-Forward Balance</p>
        <p className="text-5xl font-bold font-mono tracking-tight mt-2">{formatHM(fySurplus)}</p>
        <p className="text-sm opacity-90 mt-2">{fyLabel(today)}</p>
      </div>

      <div className="rounded-3xl bg-white border border-slate-200 p-5">
        <h3 className="font-bold text-slate-900 mb-1">Hours: Worked vs Expected</h3>
        <p className="text-xs text-slate-500 mb-5">Last 6 months</p>

        <div className="space-y-4">
          {months.map((m) => {
            const workedPct = (m.totalMinutes / maxHours) * 100;
            const expectedPct = (m.expectedMinutes / maxHours) * 100;
            return (
              <div key={m.label}>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-bold text-slate-700">{m.label}</span>
                  <span className="text-xs font-mono text-slate-600">
                    <span className="font-bold text-slate-900">{formatHMNoSign(m.totalMinutes)}</span>
                    <span className="text-slate-400"> / {formatHMNoSign(m.expectedMinutes)}</span>
                  </span>
                </div>
                <div className="relative h-3 rounded-full bg-slate-100 overflow-hidden">
                  <div className="absolute top-0 left-0 h-full bg-slate-200" style={{ width: `${expectedPct}%` }} />
                  <div
                    className={`absolute top-0 left-0 h-full rounded-full ${m.surplus >= 0 ? "bg-emerald-500" : "bg-rose-400"}`}
                    style={{ width: `${workedPct}%` }}
                  />
                </div>
                <div className="flex items-center justify-between mt-1">
                  <span className="text-[11px] text-slate-500">{m.workedDays}/{m.totalWorkingDays} days · {m.leavesTaken} leaves</span>
                  <span className={`text-[11px] font-bold ${m.surplus >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                    {formatHM(m.surplus)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   FIRESTORE SECURITY RULES (paste into Firebase Console)
   ============================================================
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /users/{userId} {
         allow read, write: if request.auth != null && request.auth.uid == userId;
       }
     }
   }
   ============================================================ */