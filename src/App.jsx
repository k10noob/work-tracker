/* ============================================================
   WORK HOURS TRACKER — Firebase Edition v3
   NEW in v3: Company Holidays + 1st-Saturday override + Alarms
   ============================================================ */

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  Home, Calendar as CalendarIcon, BarChart3, Plus, X,
  ChevronLeft, ChevronRight, Download, Clock, AlertCircle,
  Palmtree, History as HistoryIcon, TrendingUp, CheckCircle2,
  Trash2, Sparkles, LogOut, Mail, Lock, User, Loader2,
  Settings as SettingsIcon, Bell, BellOff, PartyPopper,
  Briefcase, Play, FileEdit, ShieldCheck, Check, XCircle,
  Users, ClipboardList, ScrollText, Pencil,
} from "lucide-react";

import { initializeApp } from "firebase/app";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signInWithPopup, GoogleAuthProvider, signOut, onAuthStateChanged,
  updateProfile,
} from "firebase/auth";
import {
  getFirestore, doc, setDoc, onSnapshot, serverTimestamp, getDoc,
  collection, query, where, getDocs, addDoc, updateDoc,
  orderBy, writeBatch,
} from "firebase/firestore";

// 🔑 PASTE YOUR FIREBASE CONFIG HERE
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

const TARGET_MINUTES = 510;
const ANNUAL_LEAVES = 20;
const LOCAL_KEY = "work_tracker_v1";

/* Admin authorization — the ONLY email with admin powers.
   This is checked against the Firebase Auth token email (verified by Firebase),
   never against a Firestore field a user could edit. Must be mirrored in
   firestore.rules for real enforcement. */
const ADMIN_EMAIL = "k10noob18@gmail.com";
const isAdminEmail = (email) => (email||"").trim().toLowerCase() === ADMIN_EMAIL;

/* Self-service backfill: a user may fill an EMPTY past record within this many
   days with no approval. Older than this → must go through a correction request. */
const BACKFILL_WINDOW_DAYS = 30;

const CORRECTION_TYPES = {
  check_in:         "Check-in time",
  check_out:        "Check-out time",
  status:           "Attendance status",
  leave_add:        "Add forgotten leave",
  attendance_add:   "Add forgotten attendance",
  working_day_flag: "Working-day status",
  other:            "Other",
};

/* Settings shape stored at users/{uid}.settings */
const DEFAULT_SETTINGS = {
  firstSatOverrides: {},   // { "2026-07": "working" }  → that month's 1st Sat is a working day
  companyHolidays: {},     // { "2026-07-25": { label: "Shifted Saturday off" } }
  alarms: [],              // [{ id, label, offsetMin, repeatMin, enabled }]
  alarmSound: "double",
  alarmVolume: 0.6,
  vibrate: true,
  notify: true,
};
const ALARM_GRACE_MS = 5 * 60 * 1000;   // don't blast a beep for an alarm that passed long ago

/* ---- Helpers ---- */
const pad = (n) => String(n).padStart(2, "0");
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const parseKey = (k) => { const [y,m,d]=k.split("-").map(Number); return new Date(y,m-1,d); };
const todayKey = () => dateKey(new Date());
const startOfToday = () => new Date(new Date().setHours(0,0,0,0));
const daysBetween = (a,b) => Math.round((b-a)/86400000);
// How a past empty date can be filled: self-service, request-only, or not at all.
const backfillEligibility = (dateStr) => {
  const d=parseKey(dateStr), t=startOfToday();
  if(d>t) return "future";                         // can't record the future
  const age=daysBetween(d,t);
  if(age<=BACKFILL_WINDOW_DAYS) return "self";      // within window → no approval
  return "request";                                 // older → correction request only
};
const formatTime12 = (input) => {
  const d=typeof input==="string"?new Date(input):input;
  let h=d.getHours(); const m=d.getMinutes(); const ampm=h>=12?"PM":"AM";
  h=h%12||12; return `${pad(h)}:${pad(m)} ${ampm}`;
};
const formatHMS = (totalSeconds) => {
  const sign=totalSeconds<0?"-":""; const s=Math.abs(Math.floor(totalSeconds));
  return `${sign}${pad(Math.floor(s/3600))}:${pad(Math.floor((s%3600)/60))}:${pad(s%60)}`;
};
const formatHM = (minutes) => {
  if(!minutes) return "0h 0m";
  const sign=minutes<0?"-":"+"; const abs=Math.abs(Math.round(minutes));
  return `${sign}${Math.floor(abs/60)}h ${abs%60}m`;
};
const formatHMNoSign = (minutes) => {
  const abs=Math.abs(Math.round(minutes)); return `${Math.floor(abs/60)}h ${abs%60}m`;
};
const longDate = (d) => {
  const days=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const months=["January","February","March","April","May","June","July","August","September","October","November","December"];
  return `${days[d.getDay()]}, ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
};
const shortDate = (d) => {
  const days=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const months=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${pad(d.getDate())} ${months[d.getMonth()]} ${d.getFullYear()}, ${days[d.getDay()]}`;
};
const compactDate = (d) => {
  const months=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${d.getDate()} ${months[d.getMonth()]}`;
};
const monthLabel = (year,month) => {
  const months=["January","February","March","April","May","June","July","August","September","October","November","December"];
  return `${months[month]} ${year}`;
};
const monthShort = (year,month) => {
  const months=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[month]} '${String(year).slice(-2)}`;
};
const firstSaturday = (year,month) => {
  for(let day=1;day<=7;day++) if(new Date(year,month,day).getDay()===6) return day;
  return null;
};
const monthKeyOf = (year,month) => `${year}-${pad(month+1)}`;
const isFirstSatDate = (d) => d.getDay()===6 && d.getDate()===firstSaturday(d.getFullYear(),d.getMonth());

/* ---- Off-day resolution (single source of truth) ----
   Priority:
     1. Sunday                              → always off
     2. Company holiday (custom date)       → off, NOT deducted from leave quota
     3. 1st Saturday                        → off, unless overridden to "working" for that month
     4. Everything else                     → working
*/
const dayKind = (d,settings) => {
  const s = settings || DEFAULT_SETTINGS;
  if(d.getDay()===0) return "sunday";
  if(s.companyHolidays && s.companyHolidays[dateKey(d)]) return "holiday";
  if(isFirstSatDate(d)) {
    const ov = s.firstSatOverrides ? s.firstSatOverrides[monthKeyOf(d.getFullYear(),d.getMonth())] : null;
    return ov==="working" ? "working" : "first-sat";
  }
  return "working";
};
const isOff = (d,settings) => dayKind(d,settings)!=="working";
const holidayLabel = (d,settings) => {
  const s = settings || DEFAULT_SETTINGS;
  const h = s.companyHolidays ? s.companyHolidays[dateKey(d)] : null;
  return (h && h.label) ? h.label : "Company holiday";
};
const fyStartFor = (d) => { const y=d.getMonth()>=3?d.getFullYear():d.getFullYear()-1; return new Date(y,3,1); };
const fyEndFor = (d) => { const s=fyStartFor(d); return new Date(s.getFullYear()+1,2,31); };
const fyLabel = (d) => { const s=fyStartFor(d); return `Apr ${s.getFullYear()} – Mar ${s.getFullYear()+1}`; };
const workingDaysInMonth = (year,month,settings) => {
  const last=new Date(year,month+1,0).getDate(); let n=0;
  for(let d=1;d<=last;d++) if(!isOff(new Date(year,month,d),settings)) n++;
  return n;
};
const holidaysInMonth = (year,month,settings) => {
  const last=new Date(year,month+1,0).getDate(); let n=0;
  for(let d=1;d<=last;d++) if(dayKind(new Date(year,month,d),settings)==="holiday") n++;
  return n;
};

/* ---- Week helper ---- */
const getWeeksInMonth = (year, month, logs, settings) => {
  const lastDayNum=new Date(year,month+1,0).getDate();
  const weeks=[]; let cw=null;
  for(let d=1;d<=lastDayNum;d++) {
    const date=new Date(year,month,d), dow=date.getDay();
    if(dow===1||d===1) cw={startDate:new Date(date),endDate:null,workingDays:0,workedDays:0,totalMinutes:0};
    if(cw&&!isOff(date,settings)) {
      cw.workingDays++;
      const log=logs[dateKey(date)];
      if(log?.status==="working") { cw.workedDays++; cw.totalMinutes+=log.totalMinutes||0; }
    }
    if(cw&&(dow===6||d===lastDayNum)) {
      cw.endDate=new Date(date);
      cw.surplus=cw.totalMinutes-cw.workedDays*TARGET_MINUTES;
      if(cw.workingDays>0) weeks.push(cw);
      cw=null;
    }
  }
  return weeks.map((w,i)=>({...w,weekNum:i+1}));
};

/* ---- Analytics helpers ---- */
const getMonthlyStats = (logs,year,month,settings) => {
  const totalWorkingDays=workingDaysInMonth(year,month,settings);
  const companyHolidays=holidaysInMonth(year,month,settings);
  const last=new Date(year,month+1,0).getDate();
  let workedDays=0,leavesTaken=0,totalMinutes=0;
  for(let d=1;d<=last;d++) {
    const date=new Date(year,month,d);
    const log=logs[dateKey(date)]; if(!log) continue;
    if(log.status==="working") { workedDays++; totalMinutes+=log.totalMinutes||0; }
    // a leave that later became a company holiday no longer burns quota
    else if(log.status==="leave" && !isOff(date,settings)) leavesTaken++;
  }
  return { totalWorkingDays, companyHolidays, workedDays, leavesTaken, totalMinutes, expectedMinutes:totalWorkingDays*TARGET_MINUTES, surplus:totalMinutes-workedDays*TARGET_MINUTES, avgPerDay:workedDays>0?Math.round(totalMinutes/workedDays):0 };
};
const getFYSurplus = (logs,refDate) => {
  const start=fyStartFor(refDate),end=fyEndFor(refDate); let s=0;
  Object.values(logs).forEach(l=>{ if(l.status!=="working") return; const d=parseKey(l.date); if(d>=start&&d<=end) s+=(l.totalMinutes||0)-TARGET_MINUTES; });
  return s;
};
const getLeavesUsedFY = (logs,refDate,settings) => {
  const start=fyStartFor(refDate),end=fyEndFor(refDate);
  return Object.values(logs).filter(l=>{
    if(l.status!=="leave") return false;
    const d=parseKey(l.date);
    if(d<start||d>end) return false;
    return !isOff(d,settings);   // company holiday / off day → doesn't burn quota
  }).length;
};

/* ============================================================
   ALARM ENGINE — Web Audio beeps, notifications, vibration
   No audio files needed; tones are synthesised in the browser.
   ============================================================ */
let _audioCtx = null;
const getAudioCtx = () => {
  if(typeof window==="undefined") return null;
  const AC = window.AudioContext || window.webkitAudioContext;
  if(!AC) return null;
  if(!_audioCtx) { try { _audioCtx = new AC(); } catch { return null; } }
  if(_audioCtx.state==="suspended") _audioCtx.resume().catch(()=>{});
  return _audioCtx;
};
/* Browsers block audio until the user interacts once. Any tap unlocks it. */
const unlockAudio = () => { const c=getAudioCtx(); if(c&&c.state==="suspended") c.resume().catch(()=>{}); };
if(typeof window!=="undefined") {
  const once=()=>{ unlockAudio(); window.removeEventListener("pointerdown",once); window.removeEventListener("keydown",once); };
  window.addEventListener("pointerdown",once); window.addEventListener("keydown",once);
}

const ALARM_SOUNDS = {
  single: { label:"Single beep",  seq:[[880,0.28]] },
  double: { label:"Double beep",  seq:[[880,0.16],[880,0.16]] },
  triple: { label:"Triple beep",  seq:[[880,0.14],[880,0.14],[880,0.14]] },
  chime:  { label:"Rising chime", seq:[[659,0.22],[784,0.22],[988,0.42]] },
  urgent: { label:"Urgent",       seq:[[1046,0.1],[1318,0.1],[1046,0.1],[1318,0.1],[1046,0.3]] },
};
const beepAt = (ctx,startAt,freq,dur,volume) => {
  const osc=ctx.createOscillator(), gain=ctx.createGain();
  osc.type="sine"; osc.frequency.value=freq;
  const v=Math.max(0.0001,Math.min(volume,1));
  gain.gain.setValueAtTime(0.0001,startAt);
  gain.gain.exponentialRampToValueAtTime(v,startAt+0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001,startAt+dur);
  osc.connect(gain); gain.connect(ctx.destination);
  osc.start(startAt); osc.stop(startAt+dur+0.03);
};
const playAlarmSound = (pattern="double",volume=0.6) => {
  const ctx=getAudioCtx(); if(!ctx) return;
  const seq=(ALARM_SOUNDS[pattern]||ALARM_SOUNDS.double).seq;
  let t=ctx.currentTime+0.05;
  seq.forEach(([freq,dur])=>{ beepAt(ctx,t,freq,dur,volume); t+=dur+0.09; });
};
const buzz = (enabled) => { try { if(enabled&&navigator.vibrate) navigator.vibrate([250,120,250]); } catch{} };
const notify = (enabled,title,body) => {
  try {
    if(!enabled) return;
    if(typeof Notification==="undefined"||Notification.permission!=="granted") return;
    new Notification(title,{body,tag:"work-tracker-alarm",renotify:true});
  } catch{}
};
const requestNotifyPermission = async () => {
  try { if(typeof Notification==="undefined") return "unsupported"; if(Notification.permission==="granted") return "granted"; return await Notification.requestPermission(); }
  catch { return "denied"; }
};
/* Human label for an offset relative to the 8h30m target */
const offsetLabel = (min) => {
  if(min===0) return "Exactly at 8h 30m";
  if(min<0) return `${Math.abs(min)} min before target`;
  return `${min} min after target`;
};
const ALARM_PRESETS = [
  { label:"15 min before target", offsetMin:-15, repeatMin:0 },
  { label:"10 min before target", offsetMin:-10, repeatMin:0 },
  { label:"Target reached",       offsetMin:0,   repeatMin:0 },
  { label:"30 min overtime",      offsetMin:30,  repeatMin:0 },
  { label:"Nag every 30 min",     offsetMin:0,   repeatMin:30 },
];

/* ---- Firestore hook ---- */
function useFirestoreState(userId) {
  const [state,setState]=useState({logs:{},activeTimer:null,settings:DEFAULT_SETTINGS});
  const [loading,setLoading]=useState(true);
  const [syncError,setSyncError]=useState(null);
  const writeTimer=useRef(null);
  const hydrated=useRef(false);       // has the SERVER (not cache) snapshot ever arrived?
  const pendingWrites=useRef(0);      // how many of our own writes are still in flight
  const latestState=useRef(null);     // newest local state, for flush-on-unmount

  useEffect(()=>{
    hydrated.current=false; pendingWrites.current=0;
    if(!userId){ setLoading(false); return; }
    const unsub=onSnapshot(doc(db,"users",userId),{includeMetadataChanges:true},(snap)=>{
      // Only trust a snapshot as "loaded" once it's confirmed from the server.
      if(!snap.metadata.fromCache) hydrated.current=true;

      // Ignore snapshots while our own writes are still settling — they may echo
      // pre-write state and clobber the optimistic UI.
      if(pendingWrites.current>0){
        if(!snap.metadata.hasPendingWrites) pendingWrites.current=Math.max(0,pendingWrites.current-1);
        if(!snap.metadata.fromCache) setLoading(false);
        return;
      }

      if(snap.exists()){
        const data=snap.data();
        setState({
          logs:data.logs||{},
          activeTimer:data.activeTimer||null,
          settings:{...DEFAULT_SETTINGS,...(data.settings||{})},
        });
      }
      // Don't unlock the UI on a cache-only first paint; wait for the server.
      if(!snap.metadata.fromCache) setLoading(false);
    },(err)=>{ console.error(err); setSyncError("Couldn't reach the server. Your data may not be up to date."); setLoading(false); });
    return unsub;
  },[userId]);

  const flush=async(next)=>{
    if(!userId) return;
    if(!hydrated.current){ console.warn("Blocked a write before server data loaded — protecting existing data."); return; }
    pendingWrites.current+=1;
    try {
      await setDoc(doc(db,"users",userId),{logs:next.logs,activeTimer:next.activeTimer,settings:next.settings||DEFAULT_SETTINGS,updatedAt:serverTimestamp()},{merge:true});
      setSyncError(null);
    } catch(e){
      console.error(e);
      pendingWrites.current=Math.max(0,pendingWrites.current-1);
      setSyncError("Your last change didn't save. Check your connection.");
    }
  };

  const updateState=(updater)=>{
    setState(prev=>{
      const next=typeof updater==="function"?updater(prev):updater;
      latestState.current=next;
      if(writeTimer.current) clearTimeout(writeTimer.current);
      writeTimer.current=setTimeout(()=>flush(next),500);
      return next;
    });
  };

  // Flush any pending debounced write if the tab is backgrounded or closing.
  useEffect(()=>{
    const handler=()=>{ if(writeTimer.current&&latestState.current){ clearTimeout(writeTimer.current); writeTimer.current=null; flush(latestState.current); } };
    const visHandler=()=>{ if(document.visibilityState==="hidden") handler(); };
    document.addEventListener("visibilitychange",visHandler);
    window.addEventListener("beforeunload",handler);
    return ()=>{ document.removeEventListener("visibilitychange",visHandler); window.removeEventListener("beforeunload",handler); };
  },[userId]);

  return [state,updateState,loading,syncError];
}

/* ============================================================
   CORRECTION REQUESTS + AUDIT LOG — data layer
   Top-level collections so the admin can query across users.
   All writes that change a record are atomic batches:
   record + request-status + audit entry commit together or not at all.
   ============================================================ */

// A normal user subscribes to their OWN requests. The admin subscribes to ALL.
function useCorrectionRequests(user, isAdmin) {
  const [requests,setRequests]=useState([]);
  const [loaded,setLoaded]=useState(false);
  useEffect(()=>{
    if(!user){ setRequests([]); setLoaded(true); return; }
    let q;
    try {
      q = isAdmin
        ? query(collection(db,"correctionRequests"),orderBy("createdAt","desc"))
        : query(collection(db,"correctionRequests"),where("userId","==",user.uid));
    } catch { setLoaded(true); return; }
    const unsub=onSnapshot(q,(snap)=>{
      const rows=snap.docs.map(d=>({id:d.id,...d.data()}));
      // non-admin path can't orderBy without a composite index, so sort client-side
      rows.sort((a,b)=>{
        const ta=a.createdAt?.toMillis?.()??0, tb=b.createdAt?.toMillis?.()??0;
        return tb-ta;
      });
      setRequests(rows); setLoaded(true);
    },(e)=>{ console.error(e); setLoaded(true); });
    return unsub;
  },[user?.uid,isAdmin]);
  return [requests,loaded];
}

function useAuditLog(user, isAdmin, filterUserId) {
  const [entries,setEntries]=useState([]);
  useEffect(()=>{
    if(!user){ setEntries([]); return; }
    let q;
    try {
      if(isAdmin){
        q = filterUserId
          ? query(collection(db,"auditLog"),where("userId","==",filterUserId))
          : query(collection(db,"auditLog"));
      } else {
        q = query(collection(db,"auditLog"),where("userId","==",user.uid));
      }
    } catch { return; }
    const unsub=onSnapshot(q,(snap)=>{
      const rows=snap.docs.map(d=>({id:d.id,...d.data()}));
      rows.sort((a,b)=>{ const ta=a.timestamp?.toMillis?.()??0, tb=b.timestamp?.toMillis?.()??0; return tb-ta; });
      setEntries(rows);
    },(e)=>console.error(e));
    return unsub;
  },[user?.uid,isAdmin,filterUserId]);
  return entries;
}

// Submit a correction request (user-side, no record change yet — just a request doc).
async function submitCorrectionRequest(user,{targetDate,correctionType,currentValue,requestedValue,reason}) {
  return addDoc(collection(db,"correctionRequests"),{
    userId:user.uid, userEmail:user.email||"",
    userName:user.displayName||user.email||"",
    targetDate, correctionType,
    currentValue:currentValue??null, requestedValue:requestedValue??null,
    reason:reason||"", status:"pending",
    createdAt:serverTimestamp(), decidedAt:null, decidedBy:null, adminComment:"",
  });
}

async function cancelCorrectionRequest(requestId) {
  return updateDoc(doc(db,"correctionRequests",requestId),{status:"cancelled",decidedAt:serverTimestamp()});
}

// Write a self-service backfill straight to the user's own doc + an audit entry.
// Not a batch across collections is fine here (no request doc involved), but we
// still log the audit entry so admin has passive visibility.
async function logAudit(entry) {
  return addDoc(collection(db,"auditLog"),{ timestamp:serverTimestamp(), ...entry });
}

/* Admin decision on a request — atomic:
   1. flip request status  2. (if approved) apply change to user doc  3. audit entry
   All in one writeBatch so we can't half-apply. */
async function decideCorrectionRequest({request,approve,adminUser,adminComment,applyToLogs}) {
  const batch=writeBatch(db);
  const reqRef=doc(db,"correctionRequests",request.id);
  batch.update(reqRef,{
    status:approve?"approved":"rejected",
    decidedAt:serverTimestamp(), decidedBy:adminUser.email||"", adminComment:adminComment||"",
  });
  if(approve && applyToLogs){
    const userRef=doc(db,"users",request.userId);
    batch.set(userRef,{logs:applyToLogs.nextLogs,updatedAt:serverTimestamp()},{merge:true});
  }
  const auditRef=doc(collection(db,"auditLog"));
  batch.set(auditRef,{
    userId:request.userId, targetDate:request.targetDate,
    field:request.correctionType,
    originalValue:request.currentValue??null,
    newValue:approve?(request.requestedValue??null):null,
    reason:request.reason||"", source:"user_request",
    requestId:request.id, actingAdmin:adminUser.email||"",
    status:approve?"approved":"rejected",
    timestamp:serverTimestamp(),
  });
  return batch.commit();
}

/* Admin direct edit — atomic: apply to user doc + audit entry, and supersede any
   pending request on the same date so nothing dangles. */
async function adminDirectEdit({targetUserId,nextLogs,field,originalValue,newValue,targetDate,adminUser,pendingToSupersede=[]}) {
  const batch=writeBatch(db);
  batch.set(doc(db,"users",targetUserId),{logs:nextLogs,updatedAt:serverTimestamp()},{merge:true});
  pendingToSupersede.forEach(rid=>batch.update(doc(db,"correctionRequests",rid),{status:"superseded",decidedAt:serverTimestamp(),decidedBy:adminUser.email||""}));
  const auditRef=doc(collection(db,"auditLog"));
  batch.set(auditRef,{
    userId:targetUserId, targetDate, field,
    originalValue:originalValue??null, newValue:newValue??null,
    reason:"Admin direct edit", source:"admin_direct_edit",
    requestId:null, actingAdmin:adminUser.email||"",
    status:"applied", timestamp:serverTimestamp(),
  });
  return batch.commit();
}

/* ---- UI Primitives ---- */
function ProgressRing({progress,size=160,stroke=12,color="#10b981",track="#dcfce7",children}) {
  const r=(size-stroke)/2,C=2*Math.PI*r,offset=C*(1-Math.max(0,Math.min(progress,1)));
  return (
    <div className="relative" style={{width:size,height:size}}>
      <svg width={size} height={size} style={{transform:"rotate(-90deg)"}}>
        <circle cx={size/2} cy={size/2} r={r} stroke={track} strokeWidth={stroke} fill="none"/>
        <circle cx={size/2} cy={size/2} r={r} stroke={color} strokeWidth={stroke} fill="none" strokeDasharray={C} strokeDashoffset={offset} strokeLinecap="round" style={{transition:"stroke-dashoffset 0.6s cubic-bezier(.4,0,.2,1)"}}/>
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">{children}</div>
    </div>
  );
}
function Tile({label,value,sub,tone="slate",icon:Icon}) {
  const tones={slate:"bg-slate-50 border-slate-200/70",emerald:"bg-emerald-50 border-emerald-200/70",amber:"bg-amber-50 border-amber-200/70",sky:"bg-sky-50 border-sky-200/70",violet:"bg-violet-50 border-violet-200/70",rose:"bg-rose-50 border-rose-200/70"};
  return (<div className={`rounded-2xl border p-4 ${tones[tone]}`}><div className="flex items-start justify-between"><div className="text-xs font-medium text-slate-600">{label}</div>{Icon&&<Icon className="w-4 h-4 text-slate-400"/>}</div><div className="mt-2 text-2xl font-bold text-slate-900 tracking-tight font-mono">{value}</div>{sub&&<div className="text-xs text-slate-500 mt-1">{sub}</div>}</div>);
}
function Pill({children,tone="emerald"}) {
  const tones={emerald:"bg-emerald-100 text-emerald-700 border-emerald-200",amber:"bg-amber-100 text-amber-700 border-amber-200",rose:"bg-rose-100 text-rose-700 border-rose-200",slate:"bg-slate-100 text-slate-700 border-slate-200",sky:"bg-sky-100 text-sky-700 border-sky-200",violet:"bg-violet-100 text-violet-700 border-violet-200"};
  return <span className={`inline-flex items-center text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-full border ${tones[tone]}`}>{children}</span>;
}
function Modal({open,onClose,title,children}) {
  if(!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-slate-900/40 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl shadow-2xl overflow-hidden" onClick={e=>e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100"><h3 className="font-semibold text-slate-900">{title}</h3><button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100"><X className="w-4 h-4 text-slate-500"/></button></div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

/* ---- Auth ---- */
function AuthScreen() {
  const [mode,setMode]=useState("login");
  const [email,setEmail]=useState(""); const [password,setPassword]=useState(""); const [name,setName]=useState("");
  const [error,setError]=useState(""); const [loading,setLoading]=useState(false);
  const handleEmail=async(e)=>{ e.preventDefault(); setError(""); setLoading(true); try { if(mode==="signup"){ if(!name.trim()){setError("Please enter your name.");setLoading(false);return;} const cred=await createUserWithEmailAndPassword(auth,email,password); await updateProfile(cred.user,{displayName:name.trim()}); } else { await signInWithEmailAndPassword(auth,email,password); } } catch(err){setError(prettifyAuthError(err.code));} finally{setLoading(false);} };
  const handleGoogle=async()=>{ setError(""); setLoading(true); try{await signInWithPopup(auth,googleProvider);}catch(err){setError(prettifyAuthError(err.code));}finally{setLoading(false);} };
  return (
    <div className="min-h-screen bg-stone-50 flex items-center justify-center p-4" style={{fontFamily:"'Manrope',system-ui,sans-serif"}}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;700&display=swap'); .font-mono{font-family:'JetBrains Mono',monospace;font-feature-settings:"tnum"}`}</style>
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-emerald-500 grid place-items-center shadow-lg shadow-emerald-500/30 mx-auto mb-4"><Clock className="w-8 h-8 text-white"/></div>
          <h1 className="text-2xl font-bold text-slate-900">Work Hours Tracker</h1>
          <p className="text-sm text-slate-500 mt-1">{mode==="login"?"Welcome back. Sign in to continue.":"Create an account to get started."}</p>
        </div>
        <div className="bg-white rounded-3xl border border-slate-200 p-6 shadow-sm">
          <button onClick={handleGoogle} disabled={loading} className="w-full flex items-center justify-center gap-3 px-4 py-3 rounded-xl border border-slate-200 hover:bg-slate-50 font-semibold text-sm text-slate-700 disabled:opacity-50"><GoogleIcon/> Continue with Google</button>
          <div className="flex items-center gap-3 my-5"><div className="flex-1 h-px bg-slate-200"/><span className="text-xs font-semibold text-slate-400 uppercase">or</span><div className="flex-1 h-px bg-slate-200"/></div>
          <form onSubmit={handleEmail} className="space-y-3">
            {mode==="signup"&&(<div><label className="block text-xs font-semibold text-slate-700 mb-1.5">Full name</label><div className="relative"><User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400"/><input type="text" value={name} onChange={e=>setName(e.target.value)} className="w-full pl-10 pr-3 py-3 rounded-xl border border-slate-200 focus:outline-none focus:border-emerald-500 text-sm" placeholder="Your name" required/></div></div>)}
            <div><label className="block text-xs font-semibold text-slate-700 mb-1.5">Email</label><div className="relative"><Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400"/><input type="email" value={email} onChange={e=>setEmail(e.target.value)} className="w-full pl-10 pr-3 py-3 rounded-xl border border-slate-200 focus:outline-none focus:border-emerald-500 text-sm" placeholder="you@example.com" required/></div></div>
            <div><label className="block text-xs font-semibold text-slate-700 mb-1.5">Password</label><div className="relative"><Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400"/><input type="password" value={password} onChange={e=>setPassword(e.target.value)} className="w-full pl-10 pr-3 py-3 rounded-xl border border-slate-200 focus:outline-none focus:border-emerald-500 text-sm" placeholder="At least 6 characters" required minLength={6}/></div></div>
            {error&&<div className="rounded-xl bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">{error}</div>}
            <button type="submit" disabled={loading} className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-semibold text-sm disabled:opacity-50">{loading&&<Loader2 className="w-4 h-4 animate-spin"/>}{mode==="login"?"Sign in":"Create account"}</button>
          </form>
          <p className="text-center text-sm text-slate-500 mt-5">{mode==="login"?"New here? ":"Already have an account? "}<button onClick={()=>{setMode(mode==="login"?"signup":"login");setError("");}} className="font-semibold text-emerald-600">{mode==="login"?"Create an account":"Sign in"}</button></p>
        </div>
        <p className="text-center text-xs text-slate-400 mt-5">Your data is private and secure. Synced across all your devices.</p>
      </div>
    </div>
  );
}
function GoogleIcon() {
  return (<svg width="18" height="18" viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"/><path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"/><path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"/></svg>);
}
function prettifyAuthError(code) {
  const map={"auth/email-already-in-use":"An account with this email already exists.","auth/invalid-email":"Please enter a valid email address.","auth/weak-password":"Password should be at least 6 characters.","auth/user-not-found":"No account found with this email.","auth/wrong-password":"Incorrect password.","auth/invalid-credential":"Invalid email or password.","auth/popup-closed-by-user":"Sign-in window was closed.","auth/network-request-failed":"Network error."};
  return map[code]||"Something went wrong. Please try again.";
}

/* ============================================================
   AUTH GATE
   ============================================================ */
export default function App() {
  const [user,setUser]=useState(null);
  const [userProfile,setUserProfile]=useState(null);
  const [authLoading,setAuthLoading]=useState(true);
  useEffect(() => {
  const unsub = onAuthStateChanged(auth, async (u) => {
    setUser(u);

    if (u) {
      const ref = doc(db, "users", u.uid);
      const snap = await getDoc(ref);
      const data = snap.exists() ? snap.data() : null;
      setUserProfile(data);
      console.log("[profile-sync] uid:", u.uid, "auth email:", u.email, "firestore data:", data);
      const wantName = u.displayName || "";
      const wantEmail = u.email || "";
      if (!data || data.email !== wantEmail || data.name !== wantName) {
        console.log("[profile-sync] writing", { email: wantEmail, name: wantName });
        try {
          await setDoc(ref, { email: wantEmail, name: wantName }, { merge: true });
          console.log("[profile-sync] write succeeded");
        } catch (e) { console.error("[profile-sync] write FAILED:", e.code, e.message); }
      } else {
        console.log("[profile-sync] already in sync, skipping write");
      }
    } else {
      setUserProfile(null);
    }

    setAuthLoading(false);
  });

  return unsub;
  }, []);
  if(authLoading) return <div className="min-h-screen bg-stone-50 flex items-center justify-center"><Loader2 className="w-8 h-8 animate-spin text-emerald-500"/></div>;
  if(!user) return <AuthScreen/>;
  return <WorkHoursTracker user={user} userProfile={userProfile}/>;
}

/* ============================================================
   MAIN TRACKER
   ============================================================ */
function WorkHoursTracker({ user, userProfile }) {
  const [state,setState,loadingData,syncError]=useFirestoreState(user.uid);
  const isAdmin=isAdminEmail(user.email);
  const [requests,requestsLoaded]=useCorrectionRequests(user,isAdmin);
  const myRequests=useMemo(()=>isAdmin?requests.filter(r=>r.userId===user.uid):requests,[requests,isAdmin,user.uid]);
  const pendingAdminCount=useMemo(()=>isAdmin?requests.filter(r=>r.status==="pending").length:0,[requests,isAdmin]);
  const [tab,setTab]=useState("dashboard");
  const [now,setNow]=useState(Date.now());
  const [confirmReset,setConfirmReset]=useState(false);
  const [confirmCheckout,setConfirmCheckout]=useState(false);
  const [showProfile,setShowProfile]=useState(false);
  const [showMigrate,setShowMigrate]=useState(false);
  const [ringingAlarm,setRingingAlarm]=useState(null);
  const [correctionTarget,setCorrectionTarget]=useState(null);

  const settings=state.settings||DEFAULT_SETTINGS;

  useEffect(()=>{ const id=setInterval(()=>setNow(Date.now()),1000); return ()=>clearInterval(id); },[]);
  useEffect(()=>{
    if(loadingData) return;
    try {
      const local=localStorage.getItem(LOCAL_KEY); if(!local) return;
      const parsed=JSON.parse(local);
      const hasLocal=(parsed.logs&&Object.keys(parsed.logs).length>0)||parsed.activeTimer;
      const hasCloud=Object.keys(state.logs||{}).length>0;
      const dismissed=localStorage.getItem(LOCAL_KEY+"_migrate_dismissed");
      if(hasLocal&&!hasCloud&&!dismissed) setShowMigrate(true);
    } catch{}
  },[loadingData]);

  const handleMigrate=(action)=>{ if(action==="import"){try{const local=JSON.parse(localStorage.getItem(LOCAL_KEY));setState({logs:local.logs||{},activeTimer:local.activeTimer||null});localStorage.setItem(LOCAL_KEY+"_migrate_dismissed","1");}catch(e){console.error(e);}}else{localStorage.setItem(LOCAL_KEY+"_migrate_dismissed","1");}setShowMigrate(false); };

  const today=new Date(), tKey=todayKey();
  const todayLog=state.logs[tKey], activeTimer=state.activeTimer;
  const isStaleTimer=activeTimer&&activeTimer.date!==tKey;
  const liveTimer=useMemo(()=>{
    if(!activeTimer) return null;
    const checkIn=new Date(activeTimer.checkInISO), elapsedMs=now-checkIn.getTime();
    const elapsedSec=Math.max(0,Math.floor(elapsedMs/1000)), elapsedMin=elapsedSec/60;
    return {checkIn,elapsedSec,elapsedMin,remainingMin:TARGET_MINUTES-elapsedMin,expectedCheckout:new Date(checkIn.getTime()+TARGET_MINUTES*60000)};
  },[activeTimer,now]);

  const fySurplus=useMemo(()=>getFYSurplus(state.logs,today),[state.logs]);
  const leavesUsed=useMemo(()=>getLeavesUsedFY(state.logs,today,settings),[state.logs,settings]);
  const leavesRemaining=ANNUAL_LEAVES-leavesUsed;
  const monthStats=useMemo(()=>getMonthlyStats(state.logs,today.getFullYear(),today.getMonth(),settings),[state.logs,settings]);

  const checkInNow=()=>setState(s=>({...s,activeTimer:{date:tKey,checkInISO:new Date().toISOString()}}));
  const setCheckInTime=(timeStr)=>{ const [h,m]=timeStr.split(":").map(Number); if(isNaN(h)||isNaN(m)) return; const d=new Date(); d.setHours(h,m,0,0); setState(s=>({...s,activeTimer:{date:tKey,checkInISO:d.toISOString()}})); };
  const performCheckout=(atDate=new Date(),targetDateKey=tKey)=>{ if(!activeTimer) return; const checkIn=new Date(activeTimer.checkInISO); const totalMinutes=Math.max(0,Math.round((atDate-checkIn)/60000)); setState(s=>({...s,logs:{...s.logs,[targetDateKey]:{date:targetDateKey,status:"working",checkIn:activeTimer.checkInISO,checkOut:atDate.toISOString(),totalMinutes}},activeTimer:null})); };
  // NEW: set checkout at a manually entered past/present time
  const setCheckoutTime=(timeStr)=>{ const [h,m]=timeStr.split(":").map(Number); if(isNaN(h)||isNaN(m)) return; const d=new Date(); d.setHours(h,m,0,0); performCheckout(d); };
  const checkOut=()=>performCheckout(new Date());
  const resetDay=()=>{ setState(s=>{ const nl={...s.logs}; delete nl[tKey]; return {...s,logs:nl,activeTimer:null}; }); setConfirmReset(false); };
  const finalizeStaleAt=(mode)=>{ if(!activeTimer) return; if(mode==="discard"){setState(s=>({...s,activeTimer:null}));return;} const ci=new Date(activeTimer.checkInISO); performCheckout(new Date(ci.getTime()+TARGET_MINUTES*60000),activeTimer.date); };
  const addLeave=(dateStr)=>{ if(!dateStr) return; const d=parseKey(dateStr); const kind=dayKind(d,state.settings||DEFAULT_SETTINGS); if(kind!=="working"){alert(kind==="holiday"?"That day is already a company holiday — no leave needed.":"That day is already off.");return;} if(state.logs[dateStr]?.status==="working"){alert("That day already has attendance. Submit a correction request if it's wrong.");return;} if(state.logs[dateStr]?.status==="leave"){alert("Leave is already recorded for that day.");return;} const elig=backfillEligibility(dateStr); if(elig==="future"){alert("You can't record leave for a future date.");return;} if(elig==="request"){alert(`That date is more than ${BACKFILL_WINDOW_DAYS} days old. Please submit a correction request instead.`);return;} if(leavesRemaining<=0){alert("No leave balance remaining.");return;} setState(s=>({...s,logs:{...s.logs,[dateStr]:{date:dateStr,status:"leave"}}})); if(dateStr!==tKey) logAudit({userId:user.uid,targetDate:dateStr,field:"leave_add",originalValue:null,newValue:"leave",reason:"Self-service backfill",source:"user_backfill",requestId:null,actingAdmin:null,status:"applied"}).catch(()=>{}); };
  const removeLeave=(dateStr)=>setState(s=>{ const nl={...s.logs}; delete nl[dateStr]; return {...s,logs:nl}; });

  // NEW: backfill attendance for an empty PAST working day (fixes off→working bug + Requirement 1).
  // Records a completed working log directly from entered check-in/out times.
  const addPastAttendance=(dateStr,checkInHM,checkOutHM)=>{
    if(!dateStr) return {ok:false,msg:"No date."};
    const d=parseKey(dateStr);
    if(dayKind(d,settings)!=="working") return {ok:false,msg:"That day isn't a working day. Mark it working first (Calendar), then add attendance."};
    if(state.logs[dateStr]) return {ok:false,msg:"That day already has a record. Use a correction request to change it."};
    const elig=backfillEligibility(dateStr);
    if(elig==="future") return {ok:false,msg:"You can't record attendance for a future date."};
    if(elig==="request") return {ok:false,msg:`That date is more than ${BACKFILL_WINDOW_DAYS} days old. Submit a correction request instead.`};
    const [ih,im]=checkInHM.split(":").map(Number), [oh,om]=checkOutHM.split(":").map(Number);
    if([ih,im,oh,om].some(isNaN)) return {ok:false,msg:"Enter valid check-in and check-out times."};
    const ci=new Date(d); ci.setHours(ih,im,0,0);
    const co=new Date(d); co.setHours(oh,om,0,0);
    if(co<=ci) return {ok:false,msg:"Check-out must be after check-in."};
    const totalMinutes=Math.round((co-ci)/60000);
    setState(s=>({...s,logs:{...s.logs,[dateStr]:{date:dateStr,status:"working",checkIn:ci.toISOString(),checkOut:co.toISOString(),totalMinutes}}}));
    logAudit({userId:user.uid,targetDate:dateStr,field:"attendance_add",originalValue:null,newValue:`${checkInHM}–${checkOutHM}`,reason:"Self-service backfill",source:"user_backfill",requestId:null,actingAdmin:null,status:"applied"}).catch(()=>{});
    return {ok:true};
  };
  const exportCSV=()=>{ const rows=[["Date","Day","Status","Check-in","Check-out","Total Hours","vs Target (min)"]]; Object.values(state.logs).sort((a,b)=>a.date.localeCompare(b.date)).forEach(l=>{ const d=parseKey(l.date); const days=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"]; rows.push([l.date,days[d.getDay()],l.status,l.checkIn?formatTime12(l.checkIn):"",l.checkOut?formatTime12(l.checkOut):"",l.totalMinutes!=null?formatHMNoSign(l.totalMinutes):"",l.status==="working"?(l.totalMinutes-TARGET_MINUTES):""]); }); const csv=rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(",")).join("\n"); const a=document.createElement("a"); a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"})); a.download=`work-tracker-${tKey}.csv`; a.click(); };

  /* ---- Settings mutations ---- */
  const updateSettings=(patch)=>setState(s=>({...s,settings:{...DEFAULT_SETTINGS,...(s.settings||{}),...patch}}));

  // Toggle whether a given month's 1st Saturday is a holiday or a working day
  const toggleFirstSat=(year,month)=>setState(s=>{
    const cur={...DEFAULT_SETTINGS,...(s.settings||{})};
    const ov={...(cur.firstSatOverrides||{})}, k=monthKeyOf(year,month);
    if(ov[k]==="working") delete ov[k]; else ov[k]="working";
    return {...s,settings:{...cur,firstSatOverrides:ov}};
  });

  const addCompanyHoliday=(dateStr,label)=>{
    if(!dateStr) return;
    const d=parseKey(dateStr);
    if(d.getDay()===0){ alert("Sundays are already off."); return; }
    if(state.logs[dateStr]?.status==="working"){ alert("That day already has a working log. Reset it from History first."); return; }
    setState(s=>{
      const cur={...DEFAULT_SETTINGS,...(s.settings||{})};
      const nextLogs={...s.logs};
      // If a personal leave was booked that day, free it back up — holidays don't burn quota
      if(nextLogs[dateStr]?.status==="leave") delete nextLogs[dateStr];
      return {...s,logs:nextLogs,settings:{...cur,companyHolidays:{...(cur.companyHolidays||{}),[dateStr]:{label:(label||"").trim()||"Company holiday"}}}};
    });
  };
  const removeCompanyHoliday=(dateStr)=>setState(s=>{
    const cur={...DEFAULT_SETTINGS,...(s.settings||{})};
    const ch={...(cur.companyHolidays||{})}; delete ch[dateStr];
    return {...s,settings:{...cur,companyHolidays:ch}};
  });

  /* ---- Alarm CRUD ---- */
  const addAlarm=(alarm)=>setState(s=>{
    const cur={...DEFAULT_SETTINGS,...(s.settings||{})};
    const list=[...(cur.alarms||[])];
    if(list.some(a=>a.offsetMin===alarm.offsetMin&&(a.repeatMin||0)===(alarm.repeatMin||0))) return s;
    list.push({id:`al_${Date.now()}_${Math.floor(Math.random()*1000)}`,enabled:true,repeatMin:0,...alarm});
    list.sort((a,b)=>a.offsetMin-b.offsetMin);
    return {...s,settings:{...cur,alarms:list}};
  });
  const updateAlarm=(id,patch)=>setState(s=>{
    const cur={...DEFAULT_SETTINGS,...(s.settings||{})};
    return {...s,settings:{...cur,alarms:(cur.alarms||[]).map(a=>a.id===id?{...a,...patch}:a)}};
  });
  const removeAlarm=(id)=>setState(s=>{
    const cur={...DEFAULT_SETTINGS,...(s.settings||{})};
    return {...s,settings:{...cur,alarms:(cur.alarms||[]).filter(a=>a.id!==id)}};
  });

  /* ---- Alarm firing engine ----
     Runs off the same 1s tick as the timer. Everything is computed against
     real wall-clock time, so a throttled background tab just fires late
     rather than drifting or skipping. */
  const firedRef=useRef({});          // "checkInISO|alarmId" -> next repeat index
  const [snoozes,setSnoozes]=useState([]);   // [{id, at, label}]

  const ring=useCallback((label,detail)=>{
    playAlarmSound(settings.alarmSound,settings.alarmVolume);
    buzz(settings.vibrate);
    notify(settings.notify,label,detail);
    setRingingAlarm({label,detail,at:Date.now()});
  },[settings.alarmSound,settings.alarmVolume,settings.vibrate,settings.notify]);

  useEffect(()=>{
    if(!activeTimer||activeTimer.date!==tKey) return;
    const checkIn=new Date(activeTimer.checkInISO).getTime();
    const alarms=settings.alarms||[];

    let rangThisTick=false;    // never stack two beeps on the same second

    alarms.forEach(a=>{
      if(!a.enabled) return;
      const key=`${activeTimer.checkInISO}|${a.id}`;
      const repeat=Number(a.repeatMin)||0;
      let idx=firedRef.current[key]||0;
      if(!repeat&&idx>0) return;        // one-shot alarm already handled
      const base=checkIn+(TARGET_MINUTES+Number(a.offsetMin||0))*60000;

      // walk forward through any occurrences that are already due
      for(let guard=0;guard<500;guard++){
        const fireAt=base+(repeat?idx*repeat*60000:0);
        if(now<fireAt) break;
        const late=now-fireAt;
        firedRef.current[key]=idx+1;
        if(late<ALARM_GRACE_MS){
          if(!rangThisTick){
            rangThisTick=true;
            const worked=Math.round((now-checkIn)/60000);
            ring(a.label||offsetLabel(a.offsetMin),`${formatHMNoSign(worked)} worked today.`);
          }
          break;
        }
        if(!repeat) break;     // one-shot that's long past → mark done silently
        idx=idx+1;
      }
    });

    // snoozed alarms
    if(snoozes.length){
      const due=snoozes.filter(s=>now>=s.at);
      if(due.length){
        setSnoozes(prev=>prev.filter(s=>now<s.at));
        ring(due[0].label,"Snoozed reminder.");
      }
    }
  },[now,activeTimer,tKey,settings.alarms,snoozes,ring]);

  const snoozeAlarm=(mins)=>{
    if(ringingAlarm) setSnoozes(prev=>[...prev,{id:`sn_${Date.now()}`,at:Date.now()+mins*60000,label:ringingAlarm.label}]);
    setRingingAlarm(null);
  };

  // Next upcoming alarm, for the dashboard hint
  const nextAlarm=useMemo(()=>{
    if(!activeTimer||activeTimer.date!==tKey) return null;
    const checkIn=new Date(activeTimer.checkInISO).getTime();
    let best=null;
    (settings.alarms||[]).filter(a=>a.enabled).forEach(a=>{
      const repeat=Number(a.repeatMin)||0;
      const base=checkIn+(TARGET_MINUTES+Number(a.offsetMin||0))*60000;
      let at=base;
      if(repeat&&now>=base) at=base+Math.ceil((now-base)/(repeat*60000))*repeat*60000;
      if(at>now&&(!best||at<best.at)) best={at,label:a.label||offsetLabel(a.offsetMin)};
    });
    return best;
  },[activeTimer,tKey,settings.alarms,now]);

  const todayKind=dayKind(today,settings);
  const firstSatWorking=isFirstSatDate(today)&&todayKind==="working";
  let todayState;
  if(todayKind==="sunday") todayState="off-sunday";
  else if(todayKind==="holiday") todayState="off-holiday";
  else if(todayKind==="first-sat") todayState="off-firstsat";
  else if(todayLog?.status==="leave") todayState="leave";
  else if(todayLog?.status==="working") todayState="completed";
  else if(activeTimer?.date===tKey) todayState="working";
  else todayState="not-started";

  if(loadingData) return <div className="min-h-screen bg-stone-50 flex flex-col items-center justify-center gap-3"><Loader2 className="w-8 h-8 animate-spin text-emerald-500"/><p className="text-sm text-slate-500">Syncing your data...</p></div>;
  const userInitial=(user.displayName||user.email||"?").charAt(0).toUpperCase();

  return (
    <div className="min-h-screen bg-stone-50 text-slate-900">
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;700&display=swap'); .font-mono{font-family:'JetBrains Mono',monospace;font-feature-settings:"tnum"} *{-webkit-tap-highlight-color:transparent}`}</style>
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-5 sm:py-7" style={{fontFamily:"'Manrope',system-ui,sans-serif"}}>
        <header className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-emerald-500 grid place-items-center shadow-md shadow-emerald-500/30"><Clock className="w-5 h-5 text-white"/></div>
            <div><h1 className="text-lg sm:text-xl font-bold tracking-tight">Work Hours Tracker</h1><p className="text-xs text-slate-500 font-medium">{longDate(today)}</p></div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={exportCSV} className="hidden sm:flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-200 hover:bg-slate-50 text-sm font-medium text-slate-700"><Download className="w-4 h-4"/> Export</button>
            <button onClick={()=>setShowProfile(true)} className="w-10 h-10 rounded-full bg-slate-200 hover:bg-slate-300 grid place-items-center font-bold text-slate-700 overflow-hidden">{user.photoURL?<img src={user.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer"/>:userInitial}</button>
          </div>
        </header>

        <nav className="flex items-center gap-1 mb-6 overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
          {[
            {id:"dashboard",label:"Dashboard",icon:Home},
            {id:"calendar",label:"Calendar",icon:CalendarIcon},
            {id:"leaves",label:"Leaves",icon:Palmtree},
            {id:"history",label:"History",icon:HistoryIcon},
            {id:"requests",label:"Requests",icon:FileEdit},
            {id:"analytics",label:"Analytics",icon:BarChart3},
            {id:"settings",label:"Settings",icon:SettingsIcon},
            ...(isAdmin ? [{id:"admin",label:"Admin",icon:ShieldCheck,badge:pendingAdminCount}] : [])
          ].map(({id,label,icon:Icon,badge})=>(
            <button key={id} onClick={()=>setTab(id)} className={`relative flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold whitespace-nowrap transition ${tab===id?"bg-slate-900 text-white shadow-sm":"text-slate-600 hover:bg-slate-100"}`}><Icon className="w-4 h-4"/>{label}{badge>0&&<span className="ml-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-rose-500 text-white text-[10px] font-bold grid place-items-center">{badge}</span>}</button>
          ))}
        </nav>

        {syncError&&(
          <div className="mb-5 rounded-2xl border border-rose-200 bg-rose-50 p-4 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-rose-600 mt-0.5 shrink-0"/>
            <div className="flex-1"><p className="text-sm font-semibold text-rose-900">Sync problem</p><p className="text-xs text-rose-700 mt-0.5">{syncError}</p></div>
          </div>
        )}

        {isStaleTimer&&(
          <div className="mb-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-amber-600 mt-0.5 shrink-0"/>
            <div className="flex-1">
              <p className="text-sm font-semibold text-amber-900">Unfinished session from {shortDate(parseKey(activeTimer.date))}</p>
              <p className="text-xs text-amber-700 mt-0.5">Checked in at {formatTime12(activeTimer.checkInISO)}.</p>
              <div className="flex gap-2 mt-3">
                <button onClick={()=>finalizeStaleAt("complete-target")} className="px-3 py-1.5 rounded-lg bg-amber-600 text-white text-xs font-semibold">Mark complete (8h 30m)</button>
                <button onClick={()=>finalizeStaleAt("discard")} className="px-3 py-1.5 rounded-lg bg-white border border-amber-300 text-amber-800 text-xs font-semibold">Discard</button>
              </div>
            </div>
          </div>
        )}

        {tab==="dashboard"&&<DashboardView today={today} todayState={todayState} todayLog={todayLog} activeTimer={activeTimer} liveTimer={liveTimer} monthStats={monthStats} leavesUsed={leavesUsed} leavesRemaining={leavesRemaining} fySurplus={fySurplus} logs={state.logs} settings={settings} nextAlarm={nextAlarm} firstSatWorking={firstSatWorking} toggleFirstSat={()=>toggleFirstSat(today.getFullYear(),today.getMonth())} checkInNow={checkInNow} setCheckInTime={setCheckInTime} setCheckoutTime={setCheckoutTime} checkOut={()=>setConfirmCheckout(true)} resetDay={()=>setConfirmReset(true)} goToLeaves={()=>setTab("leaves")} goToHistory={()=>setTab("history")} goToSettings={()=>setTab("settings")}/>}
        {tab==="calendar"&&<CalendarView logs={state.logs} todayKey={tKey} settings={settings} toggleFirstSat={toggleFirstSat} addCompanyHoliday={addCompanyHoliday} removeCompanyHoliday={removeCompanyHoliday}/>}
        {tab==="leaves"&&<LeavesView logs={state.logs} settings={settings} leavesUsed={leavesUsed} leavesRemaining={leavesRemaining} addLeave={addLeave} removeLeave={removeLeave}/>}
        {tab==="history"&&<HistoryView logs={state.logs} exportCSV={exportCSV} onRequestCorrection={(dateStr)=>{setCorrectionTarget(dateStr);setTab("requests");}}/>}
        {tab==="analytics"&&<AnalyticsView logs={state.logs} fySurplus={fySurplus} settings={settings}/>}
        {tab==="settings"&&<SettingsView settings={settings} updateSettings={updateSettings} toggleFirstSat={toggleFirstSat} addCompanyHoliday={addCompanyHoliday} removeCompanyHoliday={removeCompanyHoliday} addAlarm={addAlarm} updateAlarm={updateAlarm} removeAlarm={removeAlarm}/>}
        {tab==="requests"&&<RequestsView user={user} logs={state.logs} settings={settings} myRequests={myRequests} correctionTarget={correctionTarget} clearCorrectionTarget={()=>setCorrectionTarget(null)} addPastAttendance={addPastAttendance} addLeave={addLeave}/>}
        {tab==="admin"&&(isAdmin
          ? <AdminView adminUser={user} requests={requests} settings={settings}/>
          : <div className="rounded-3xl bg-white border border-slate-200 p-8 text-center"><ShieldCheck className="w-10 h-10 text-slate-300 mx-auto mb-3"/><p className="font-semibold text-slate-900">Admins only</p><p className="text-sm text-slate-500 mt-1">This area is restricted.</p></div>)}

        <footer className="mt-10 pt-6 border-t border-slate-200 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs text-slate-500">
          <div className="flex items-center gap-2"><Sparkles className="w-3.5 h-3.5 text-amber-500"/><span>Synced to cloud · {fyLabel(today)}</span></div>
          <span>Signed in as {user.displayName||user.email}</span>
        </footer>

        <Modal open={showProfile} onClose={()=>setShowProfile(false)} title="Your account">
          <div className="flex items-center gap-3 mb-5"><div className="w-14 h-14 rounded-full bg-emerald-100 grid place-items-center font-bold text-emerald-700 text-xl overflow-hidden">{user.photoURL?<img src={user.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer"/>:userInitial}</div><div className="flex-1 min-w-0"><p className="font-semibold text-slate-900 truncate">{user.displayName||"User"}</p><p className="text-xs text-slate-500 truncate">{user.email}</p></div></div>
          <button onClick={exportCSV} className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-slate-200 hover:bg-slate-50 font-semibold text-sm mb-2"><Download className="w-4 h-4"/> Export data (CSV)</button>
          <button onClick={()=>signOut(auth)} className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-semibold text-sm"><LogOut className="w-4 h-4"/> Sign out</button>
        </Modal>
        <Modal open={showMigrate} onClose={()=>handleMigrate("dismiss")} title="Import existing data?">
          <p className="text-sm text-slate-600 mb-4">We found work tracking data on this device. Import it to your account?</p>
          <div className="flex gap-2"><button onClick={()=>handleMigrate("dismiss")} className="flex-1 px-4 py-2.5 rounded-xl border border-slate-200 font-semibold text-sm">Skip</button><button onClick={()=>handleMigrate("import")} className="flex-1 px-4 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white font-semibold text-sm">Import</button></div>
        </Modal>
        <Modal open={confirmReset} onClose={()=>setConfirmReset(false)} title="Reset today?">
          <p className="text-sm text-slate-600">This clears today's check-in, check-out and total hours.</p>
          <div className="flex gap-2 mt-5"><button onClick={()=>setConfirmReset(false)} className="flex-1 px-4 py-2.5 rounded-xl border border-slate-200 font-semibold text-sm">Cancel</button><button onClick={resetDay} className="flex-1 px-4 py-2.5 rounded-xl bg-rose-500 text-white font-semibold text-sm">Reset</button></div>
        </Modal>
        <Modal open={!!ringingAlarm} onClose={()=>setRingingAlarm(null)} title="Alarm">
          {ringingAlarm&&(
            <div>
              <div className="flex items-center gap-3 mb-4">
                <div className="w-12 h-12 rounded-2xl bg-amber-100 grid place-items-center shrink-0"><Bell className="w-6 h-6 text-amber-600"/></div>
                <div className="min-w-0"><p className="font-bold text-slate-900">{ringingAlarm.label}</p><p className="text-xs text-slate-500 mt-0.5">{ringingAlarm.detail}</p></div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button onClick={()=>snoozeAlarm(5)} className="px-4 py-2.5 rounded-xl border border-slate-200 font-semibold text-sm">Snooze 5 min</button>
                <button onClick={()=>setRingingAlarm(null)} className="px-4 py-2.5 rounded-xl bg-slate-900 text-white font-semibold text-sm">Dismiss</button>
              </div>
              <button onClick={()=>{setRingingAlarm(null);setConfirmCheckout(true);}} className="w-full mt-2 px-4 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white font-semibold text-sm">Check out now</button>
            </div>
          )}
        </Modal>
        <Modal open={confirmCheckout} onClose={()=>setConfirmCheckout(false)} title="Check out now?">
          {liveTimer&&(<div className="text-sm text-slate-600"><p>You'll log <span className="font-bold text-slate-900">{formatHMNoSign(liveTimer.elapsedMin)}</span> for today.</p>{liveTimer.elapsedMin<TARGET_MINUTES&&<p className="mt-2 text-rose-600 font-medium">Deficit of {formatHMNoSign(TARGET_MINUTES-liveTimer.elapsedMin)}.</p>}{liveTimer.elapsedMin>TARGET_MINUTES&&<p className="mt-2 text-emerald-600 font-medium">Surplus of {formatHMNoSign(liveTimer.elapsedMin-TARGET_MINUTES)}.</p>}</div>)}
          <div className="flex gap-2 mt-5"><button onClick={()=>setConfirmCheckout(false)} className="flex-1 px-4 py-2.5 rounded-xl border border-slate-200 font-semibold text-sm">Cancel</button><button onClick={()=>{checkOut();setConfirmCheckout(false);}} className="flex-1 px-4 py-2.5 rounded-xl bg-slate-900 text-white font-semibold text-sm">Check out</button></div>
        </Modal>
      </div>
    </div>
  );
}

/* ============================================================
   DASHBOARD VIEW
   ============================================================ */
function DashboardView({today,todayState,todayLog,activeTimer,liveTimer,monthStats,leavesUsed,leavesRemaining,fySurplus,logs,settings,nextAlarm,firstSatWorking,toggleFirstSat,checkInNow,setCheckInTime,setCheckoutTime,checkOut,resetDay,goToLeaves,goToHistory,goToSettings}) {
  const [showCheckinPicker,setShowCheckinPicker]=useState(false);
  const [manualTime,setManualTime]=useState(()=>{ const d=new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; });
  const recent=useMemo(()=>Object.values(logs).filter(l=>l.date!==todayKey()).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,5),[logs]);
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
      <div className="lg:col-span-2 space-y-5">
        <TimerCard today={today} todayState={todayState} todayLog={todayLog} liveTimer={liveTimer} settings={settings} nextAlarm={nextAlarm} firstSatWorking={firstSatWorking} toggleFirstSat={toggleFirstSat} goToSettings={goToSettings} checkInNow={checkInNow} setCheckInTime={setCheckInTime} setCheckoutTime={setCheckoutTime} checkOut={checkOut} resetDay={resetDay} showCheckinPicker={showCheckinPicker} setShowCheckinPicker={setShowCheckinPicker} manualTime={manualTime} setManualTime={setManualTime}/>
        <section className="rounded-3xl bg-white border border-slate-200 p-5">
          <div className="flex items-center justify-between mb-4"><div><h2 className="font-bold text-slate-900">Monthly Summary</h2><p className="text-xs text-slate-500 mt-0.5">{monthLabel(today.getFullYear(),today.getMonth())}</p></div><button onClick={goToHistory} className="text-xs font-semibold text-emerald-600">View all →</button></div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Tile label="Working Days" value={monthStats.totalWorkingDays} sub="this month" tone="sky" icon={CalendarIcon}/>
            <Tile label="Days Worked" value={monthStats.workedDays} sub={`of ${monthStats.totalWorkingDays}`} tone="emerald" icon={CheckCircle2}/>
            <Tile label="Leaves Taken" value={monthStats.leavesTaken} sub={monthStats.companyHolidays>0?`+${monthStats.companyHolidays} co. holiday${monthStats.companyHolidays>1?"s":""}`:"this month"} tone="amber" icon={Palmtree}/>
            <Tile label="Total Hours" value={formatHMNoSign(monthStats.totalMinutes)} sub={`avg ${formatHMNoSign(monthStats.avgPerDay)}/day`} tone="violet" icon={Clock}/>
          </div>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="rounded-2xl border border-slate-200 p-4 flex items-center justify-between"><div><div className="text-xs font-medium text-slate-500">Expected Hours</div><div className="font-mono font-bold text-lg mt-1">{formatHMNoSign(monthStats.expectedMinutes)}</div></div><Clock className="w-5 h-5 text-slate-300"/></div>
            <div className={`rounded-2xl border p-4 flex items-center justify-between ${monthStats.surplus>=0?"border-emerald-200 bg-emerald-50/50":"border-rose-200 bg-rose-50/50"}`}><div><div className="text-xs font-medium text-slate-500">Surplus / Deficit</div><div className={`font-mono font-bold text-lg mt-1 ${monthStats.surplus>=0?"text-emerald-700":"text-rose-700"}`}>{formatHM(monthStats.surplus)}</div></div><TrendingUp className={`w-5 h-5 ${monthStats.surplus>=0?"text-emerald-400":"text-rose-400"}`}/></div>
          </div>
        </section>
        <section className="rounded-3xl bg-white border border-slate-200 p-5">
          <div className="flex items-center justify-between mb-3"><h2 className="font-bold text-slate-900">Recent Days</h2><button onClick={goToHistory} className="text-xs font-semibold text-emerald-600">View all →</button></div>
          {recent.length===0?<p className="text-sm text-slate-500 py-6 text-center">No history yet.</p>:<ul className="divide-y divide-slate-100">{recent.map(l=><RecentRow key={l.date} log={l}/>)}</ul>}
        </section>
      </div>
      <div className="space-y-5">
        <section className="rounded-3xl bg-white border border-slate-200 p-5">
          <div><h2 className="font-bold text-slate-900">Leave Balance</h2><p className="text-xs text-slate-500 mt-0.5">{fyLabel(today)}</p></div>
          <div className="flex justify-center my-4"><ProgressRing progress={leavesUsed/ANNUAL_LEAVES} size={170} stroke={14} color="#8b5cf6" track="#f3e8ff"><div className="text-xs font-medium text-slate-500">Leaves Used</div><div className="text-4xl font-bold font-mono text-slate-900 mt-1">{leavesUsed}</div><div className="text-xs text-slate-400 mt-0.5">of {ANNUAL_LEAVES}</div></ProgressRing></div>
          <div className="text-center mb-4"><p className="text-xs font-medium text-slate-500">Remaining</p><p className="text-3xl font-bold text-slate-900 font-mono">{leavesRemaining}</p></div>
          <button onClick={goToLeaves} className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-emerald-500 text-white font-semibold text-sm hover:bg-emerald-600 shadow-sm shadow-emerald-500/30"><Plus className="w-4 h-4"/> Add Leave</button>
        </section>
        <section className={`rounded-3xl p-5 border ${fySurplus>=0?"bg-gradient-to-br from-emerald-500 to-emerald-600 border-emerald-600":"bg-gradient-to-br from-rose-500 to-rose-600 border-rose-600"} text-white shadow-lg`}>
          <div className="flex items-center justify-between mb-3"><p className="text-xs font-bold uppercase tracking-wider opacity-90">Carry-Forward Balance</p><TrendingUp className="w-4 h-4 opacity-80"/></div>
          <p className="text-4xl font-bold font-mono tracking-tight">{formatHM(fySurplus)}</p>
          <p className="text-xs mt-2 opacity-90">{fySurplus>=0?`${formatHMNoSign(fySurplus)} credit this FY.`:`Behind by ${formatHMNoSign(Math.abs(fySurplus))} this FY.`}</p>
        </section>
      </div>
    </div>
  );
}

/* ============================================================
   TIMER CARD — with Set Checkout Time
   ============================================================ */
function TimerCard({today,todayState,todayLog,liveTimer,settings,nextAlarm,firstSatWorking,toggleFirstSat,goToSettings,checkInNow,setCheckInTime,setCheckoutTime,checkOut,resetDay,showCheckinPicker,setShowCheckinPicker,manualTime,setManualTime}) {
  const [showCheckoutPicker,setShowCheckoutPicker]=useState(false);
  const [checkoutTimeLocal,setCheckoutTimeLocal]=useState(()=>{ const d=new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; });

  if(todayState==="off-sunday") return (
    <section className="rounded-3xl bg-gradient-to-br from-slate-100 to-slate-50 border border-slate-200 p-6">
      <div className="mb-3"><Pill tone="slate">Off Day</Pill></div>
      <h2 className="text-2xl font-bold text-slate-900">Sunday off</h2>
      <p className="text-sm text-slate-500 mt-1">No work expected today. Recharge.</p>
    </section>
  );
  if(todayState==="off-holiday") return (
    <section className="rounded-3xl bg-gradient-to-br from-sky-50 to-sky-100/40 border border-sky-200 p-6">
      <div className="mb-3"><Pill tone="sky">Company Holiday</Pill></div>
      <h2 className="text-2xl font-bold text-slate-900">{holidayLabel(today,settings)}</h2>
      <p className="text-sm text-slate-500 mt-1">Declared by the company — this does not touch your leave quota.</p>
    </section>
  );
  if(todayState==="off-firstsat") return (
    <section className="rounded-3xl bg-gradient-to-br from-slate-100 to-slate-50 border border-slate-200 p-6">
      <div className="mb-3"><Pill tone="slate">Off Day</Pill></div>
      <h2 className="text-2xl font-bold text-slate-900">First Saturday off</h2>
      <p className="text-sm text-slate-500 mt-1">No work expected today. Recharge.</p>
      <div className="mt-5 pt-4 border-t border-slate-200">
        <p className="text-xs text-slate-500 mb-2">Called in to work anyway?</p>
        <button onClick={toggleFirstSat} className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white border border-slate-300 font-semibold text-sm text-slate-700 hover:bg-slate-50"><Briefcase className="w-4 h-4"/> I'm working today</button>
        <p className="text-[11px] text-slate-400 mt-2">Applies only to this month's 1st Saturday. The default rule stays intact.</p>
      </div>
    </section>
  );
  if(todayState==="leave") return (
    <section className="rounded-3xl bg-gradient-to-br from-amber-50 to-yellow-50 border border-amber-200 p-6">
      <div className="mb-3"><Pill tone="amber">On Leave</Pill></div>
      <h2 className="text-2xl font-bold text-slate-900">Enjoy your day off</h2>
    </section>
  );
  if(todayState==="completed") {
    const total=todayLog.totalMinutes, surplus=total-TARGET_MINUTES;
    return (
      <section className="rounded-3xl bg-gradient-to-br from-emerald-50 to-emerald-100/40 border border-emerald-200 p-6">
        <div className="flex items-center justify-between mb-4"><Pill tone="emerald">Day Complete</Pill><button onClick={resetDay} className="text-xs font-semibold text-slate-600">Reset Day</button></div>
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-6 items-center">
          <div><p className="text-xs font-medium text-slate-500 mb-1">You worked</p><p className="text-5xl font-bold font-mono text-emerald-700 tracking-tight">{formatHMNoSign(total)}</p><p className={`text-sm font-semibold mt-2 ${surplus>=0?"text-emerald-600":"text-rose-600"}`}>{surplus>=0?`+${formatHMNoSign(surplus)} surplus`:`${formatHMNoSign(Math.abs(surplus))} deficit`}</p></div>
          <div className="flex justify-center"><ProgressRing progress={Math.min(total/TARGET_MINUTES,1)} size={150} stroke={12} color="#10b981" track="#dcfce7"><CheckCircle2 className="w-10 h-10 text-emerald-500"/></ProgressRing></div>
        </div>
        <div className="grid grid-cols-2 gap-3 mt-5 pt-5 border-t border-emerald-200">
          <div><p className="text-xs text-slate-500">Check-in</p><p className="font-semibold text-slate-900">{formatTime12(todayLog.checkIn)}</p></div>
          <div><p className="text-xs text-slate-500">Check-out</p><p className="font-semibold text-slate-900">{formatTime12(todayLog.checkOut)}</p></div>
        </div>
      </section>
    );
  }
  if(todayState==="working") {
    const {elapsedSec,elapsedMin,remainingMin,expectedCheckout,checkIn}=liveTimer;
    const isSurplus=elapsedMin>=TARGET_MINUTES;
    return (
      <section className="rounded-3xl bg-gradient-to-br from-emerald-50 via-emerald-50/60 to-white border border-emerald-200 p-6">
        <div className="flex items-center justify-between mb-5"><Pill tone="emerald">Working</Pill><span className="text-xs font-medium text-slate-500">{longDate(today)}</span></div>
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-6 items-center">
          <div>
            <p className="text-xs font-medium text-slate-500 mb-1">{isSurplus?"Surplus Time":"Time Remaining"}</p>
            <p className={`text-5xl sm:text-6xl font-bold font-mono tracking-tight ${isSurplus?"text-emerald-600":"text-emerald-700"}`}>{isSurplus?`+${formatHMS((elapsedMin-TARGET_MINUTES)*60)}`:formatHMS(remainingMin*60)}</p>
            <p className="text-xs text-slate-500 mt-2">( 8h 30m daily target )</p>
          </div>
          <div className="flex justify-center">
            <ProgressRing progress={Math.min(elapsedMin/TARGET_MINUTES,1)} size={170} stroke={14} color={isSurplus?"#059669":"#10b981"} track="#dcfce7">
              <div className="text-xs font-medium text-slate-500">Worked</div>
              <div className="text-2xl font-bold font-mono text-slate-900 mt-1">{formatHMS(elapsedSec)}</div>
              <div className="text-[10px] text-slate-400 mt-0.5">of 8h 30m</div>
            </ProgressRing>
          </div>
        </div>
        <div className="mt-6 space-y-3">
          <div className="flex items-center justify-between py-2 border-t border-emerald-200/60"><span className="text-sm text-slate-600">Check-in Time</span><span className="font-semibold text-slate-900 font-mono text-sm">{formatTime12(checkIn)}</span></div>
          <div className="flex items-center justify-between py-2 border-t border-emerald-200/60"><span className="text-sm text-slate-600">Expected Check-out</span><span className="font-semibold text-slate-900 font-mono text-sm">{formatTime12(expectedCheckout)}</span></div>
          <div className="flex items-center justify-between py-2 border-t border-emerald-200/60">
            <span className="text-sm text-slate-600 flex items-center gap-1.5">{nextAlarm?<Bell className="w-3.5 h-3.5 text-amber-500"/>:<BellOff className="w-3.5 h-3.5 text-slate-300"/>}Next alarm</span>
            {nextAlarm
              ? <span className="font-semibold text-slate-900 font-mono text-sm">{formatTime12(new Date(nextAlarm.at))}</span>
              : <button onClick={goToSettings} className="text-xs font-semibold text-emerald-600">Set one →</button>}
          </div>
          {nextAlarm&&<p className="text-[11px] text-slate-400 -mt-1">{nextAlarm.label}</p>}
        </div>
        {/* ── Set Checkout Time picker ── */}
        {showCheckoutPicker?(
          <div className="mt-4 p-4 bg-white rounded-2xl border border-slate-200 space-y-3">
            <p className="text-sm font-semibold text-slate-700">Enter your actual checkout time</p>
            <input type="time" value={checkoutTimeLocal} onChange={e=>setCheckoutTimeLocal(e.target.value)} className="w-full px-4 py-3 rounded-xl border border-slate-200 font-mono text-lg focus:outline-none focus:border-emerald-500"/>
            <div className="grid grid-cols-2 gap-3">
              <button onClick={()=>setShowCheckoutPicker(false)} className="px-4 py-3 rounded-xl border border-slate-200 font-semibold text-sm">Cancel</button>
              <button onClick={()=>{setCheckoutTime(checkoutTimeLocal);setShowCheckoutPicker(false);}} className="px-4 py-3 rounded-xl bg-slate-900 text-white font-semibold text-sm">Confirm</button>
            </div>
          </div>
        ):(
          <div className="grid grid-cols-2 gap-3 mt-5">
            <button onClick={checkOut} className={`px-4 py-3 rounded-xl font-semibold text-sm shadow-sm transition ${isSurplus?"bg-emerald-500 hover:bg-emerald-600 text-white":"bg-rose-500 hover:bg-rose-600 text-white"}`}>{isSurplus?"Check Out":"Check-out Early"}</button>
            <button onClick={()=>setShowCheckoutPicker(true)} className="px-4 py-3 rounded-xl border border-slate-200 bg-white font-semibold text-sm text-slate-700 hover:bg-slate-50">Set Checkout Time</button>
          </div>
        )}
        <button onClick={resetDay} className="w-full mt-2 px-4 py-2.5 rounded-xl border border-slate-100 text-sm font-medium text-slate-500 hover:bg-slate-50">Reset Day</button>
      </section>
    );
  }
  // Not started
  return (
    <section className="rounded-3xl bg-gradient-to-br from-slate-50 to-white border border-slate-200 p-6">
      <div className="flex items-center justify-between mb-4"><Pill tone="slate">Not Checked In</Pill><span className="text-xs font-medium text-slate-500">{longDate(today)}</span></div>
      <h2 className="text-2xl font-bold text-slate-900">Ready to start your day?</h2>
      <p className="text-sm text-slate-500 mt-1 mb-6">Check in to begin tracking. Target: 8h 30m.</p>
      {firstSatWorking&&(
        <div className="mb-5 rounded-2xl border border-sky-200 bg-sky-50 p-3 flex items-center justify-between gap-3">
          <p className="text-xs text-sky-800 font-medium">1st Saturday — marked as a <span className="font-bold">working day</span> for this month.</p>
          <button onClick={toggleFirstSat} className="shrink-0 px-3 py-1.5 rounded-lg bg-white border border-sky-300 text-sky-700 text-xs font-semibold">Undo</button>
        </div>
      )}
      {showCheckinPicker?(
        <div className="space-y-3">
          <label className="block text-xs font-semibold text-slate-700">Check-in time</label>
          <input type="time" value={manualTime} onChange={e=>setManualTime(e.target.value)} className="w-full px-4 py-3 rounded-xl border border-slate-200 font-mono text-lg focus:outline-none focus:border-emerald-500"/>
          <div className="grid grid-cols-2 gap-3"><button onClick={()=>setShowCheckinPicker(false)} className="px-4 py-3 rounded-xl border border-slate-200 font-semibold text-sm">Cancel</button><button onClick={()=>{setCheckInTime(manualTime);setShowCheckinPicker(false);}} className="px-4 py-3 rounded-xl bg-slate-900 text-white font-semibold text-sm">Confirm</button></div>
        </div>
      ):(
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <button onClick={checkInNow} className="px-4 py-3.5 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white font-semibold text-sm shadow-sm shadow-emerald-500/30">Check-in Now</button>
          <button onClick={()=>setShowCheckinPicker(true)} className="px-4 py-3.5 rounded-xl border border-slate-200 bg-white font-semibold text-sm text-slate-700 hover:bg-slate-50">Set Check-in Time</button>
        </div>
      )}
    </section>
  );
}

function RecentRow({log}) {
  const d=parseKey(log.date);
  if(log.status==="leave") return (<li className="flex items-center justify-between py-3"><div><p className="font-semibold text-sm text-slate-900">{shortDate(d)}</p><p className="text-xs text-slate-500 mt-0.5">Leave taken</p></div><Pill tone="amber">Leave</Pill></li>);
  const surplus=log.totalMinutes-TARGET_MINUTES;
  return (<li className="flex items-center justify-between py-3"><div><p className="font-semibold text-sm text-slate-900">{shortDate(d)}</p><p className="text-xs text-slate-500 mt-0.5 font-mono">{formatTime12(log.checkIn)} – {formatTime12(log.checkOut)}</p></div><div className="text-right"><p className="font-mono font-bold text-sm text-slate-900">{formatHMNoSign(log.totalMinutes)}</p><p className={`text-xs font-semibold ${surplus>=0?"text-emerald-600":"text-rose-600"}`}>{surplus>=0?`+${formatHMNoSign(surplus)}`:`−${formatHMNoSign(Math.abs(surplus))}`}</p></div></li>);
}

/* ============================================================
   CALENDAR VIEW
   ============================================================ */
function CalendarView({logs,todayKey:tKey,settings,toggleFirstSat,addCompanyHoliday,removeCompanyHoliday}) {
  const [cursor,setCursor]=useState(()=>{ const t=new Date(); return {year:t.getFullYear(),month:t.getMonth()}; });
  const [selected,setSelected]=useState(null);      // Date object
  const [holidayLabelInput,setHolidayLabelInput]=useState("");
  const today=new Date(), {year,month}=cursor;
  const firstDay=new Date(year,month,1), startOffset=(firstDay.getDay()+6)%7, lastDay=new Date(year,month+1,0).getDate();
  const cells=[]; const prevLast=new Date(year,month,0).getDate();
  for(let i=startOffset-1;i>=0;i--) cells.push({day:prevLast-i,inMonth:false,date:new Date(year,month-1,prevLast-i)});
  for(let d=1;d<=lastDay;d++) cells.push({day:d,inMonth:true,date:new Date(year,month,d)});
  while(cells.length%7!==0||cells.length<42) { const idx=cells.length-lastDay-startOffset+1; cells.push({day:idx,inMonth:false,date:new Date(year,month+1,idx)}); if(cells.length>=42) break; }
  const navigate=(delta)=>{ const nm=month+delta; if(nm<0) setCursor({year:year-1,month:11}); else if(nm>11) setCursor({year:year+1,month:0}); else setCursor({year,month:nm}); };
  const monthStats=useMemo(()=>getMonthlyStats(logs,year,month,settings),[logs,year,month,settings]);
  const selKind=selected?dayKind(selected,settings):null;
  const selKey=selected?dateKey(selected):null;
  const selLog=selKey?logs[selKey]:null;
  return (
    <div className="space-y-5">
      <div className="rounded-3xl bg-white border border-slate-200 p-5">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2"><button onClick={()=>navigate(-1)} className="p-2 rounded-lg hover:bg-slate-100"><ChevronLeft className="w-4 h-4"/></button><h2 className="font-bold text-slate-900 min-w-[140px] text-center">{monthLabel(year,month)}</h2><button onClick={()=>navigate(1)} className="p-2 rounded-lg hover:bg-slate-100"><ChevronRight className="w-4 h-4"/></button></div>
          <button onClick={()=>setCursor({year:today.getFullYear(),month:today.getMonth()})} className="px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-600 hover:bg-slate-100">Today</button>
        </div>
        <div className="grid grid-cols-7 mb-2">{["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(d=><div key={d} className="text-center text-[11px] font-bold uppercase tracking-wider text-slate-400 py-2">{d}</div>)}</div>
        <div className="grid grid-cols-7 gap-1.5">
          {cells.map((c,i)=>{ const k=dateKey(c.date),log=logs[k],kind=dayKind(c.date,settings),isToday=k===tKey,isSel=selKey===k&&c.inMonth; let bg="bg-white border-slate-100",textColor="text-slate-700",label=null;
            if(!c.inMonth){bg="bg-transparent border-transparent";textColor="text-slate-300";}
            else if(log?.status==="working"){const s=log.totalMinutes-TARGET_MINUTES;bg=s>=0?"bg-emerald-100 border-emerald-200":"bg-rose-100 border-rose-200";textColor=s>=0?"text-emerald-800":"text-rose-800";}
            else if(kind==="holiday"){bg="bg-sky-100 border-sky-300";textColor="text-sky-800";label="H";}
            else if(log?.status==="leave"){bg="bg-amber-100 border-amber-200";textColor="text-amber-800";label="L";}
            else if(kind==="sunday"){bg="bg-rose-50/40 border-rose-100";textColor="text-rose-400";}
            else if(kind==="first-sat"){bg="bg-amber-50/40 border-amber-100";textColor="text-amber-500";}
            else if(isFirstSatDate(c.date)){bg="bg-white border-sky-200";textColor="text-slate-700";label="W";}
            return (<button key={i} type="button" disabled={!c.inMonth} onClick={()=>{setSelected(c.date);setHolidayLabelInput("");}} className={`aspect-square rounded-xl border ${bg} ${textColor} flex flex-col items-center justify-center text-sm font-semibold relative ${isToday?"ring-2 ring-slate-900 ring-offset-1":""} ${isSel?"ring-2 ring-sky-500 ring-offset-1":""} ${c.inMonth?"hover:brightness-95 cursor-pointer":"cursor-default"}`}><span>{c.day}</span>{label&&<span className="text-[9px] absolute bottom-1 font-bold">{label}</span>}</button>);
          })}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-2 mt-5 pt-4 border-t border-slate-100 text-xs text-slate-600">{[{c:"bg-emerald-400",l:"Worked (met)"},{c:"bg-rose-400",l:"Worked (deficit)"},{c:"bg-amber-300",l:"Leave"},{c:"bg-sky-400",l:"Company holiday"},{c:"bg-rose-200",l:"Sunday"},{c:"bg-amber-200",l:"1st Saturday off"},{c:"bg-white border border-sky-300",l:"1st Sat — working"}].map(({c,l})=><div key={l} className="flex items-center gap-1.5"><span className={`w-2.5 h-2.5 rounded-full ${c}`}></span><span>{l}</span></div>)}</div>
        <p className="text-[11px] text-slate-400 mt-3">Tap any day to mark it as a company holiday or flip a 1st Saturday.</p>
      </div>

      {/* ── Day editor ── */}
      {selected&&(
        <div className="rounded-3xl bg-white border border-slate-200 p-5">
          <div className="flex items-start justify-between mb-4">
            <div>
              <h3 className="font-bold text-slate-900">{longDate(selected)}</h3>
              <p className="text-xs text-slate-500 mt-0.5">
                {selKind==="sunday"?"Weekly off (Sunday)":selKind==="holiday"?holidayLabel(selected,settings):selKind==="first-sat"?"1st Saturday — off":selLog?.status==="leave"?"Personal leave":selLog?.status==="working"?`Worked ${formatHMNoSign(selLog.totalMinutes)}`:"Regular working day"}
              </p>
            </div>
            <button onClick={()=>setSelected(null)} className="p-1.5 rounded-lg hover:bg-slate-100"><X className="w-4 h-4 text-slate-500"/></button>
          </div>

          {selKind==="sunday"&&<p className="text-sm text-slate-500">Sundays are always off — nothing to change here.</p>}

          {isFirstSatDate(selected)&&(
            <div className="rounded-2xl border border-slate-200 p-4 mb-3">
              <p className="text-sm font-semibold text-slate-800 mb-1">1st Saturday of {monthLabel(selected.getFullYear(),selected.getMonth())}</p>
              <p className="text-xs text-slate-500 mb-3">{selKind==="first-sat"?"Currently treated as an off day.":"Currently treated as a working day."}</p>
              <button onClick={()=>toggleFirstSat(selected.getFullYear(),selected.getMonth())} className="px-4 py-2.5 rounded-xl bg-slate-900 text-white font-semibold text-sm">
                {selKind==="first-sat"?"Mark as working day":"Mark as off day"}
              </button>
              <p className="text-[11px] text-slate-400 mt-2">Only affects this month. The default 1st-Saturday-off rule is untouched.</p>
            </div>
          )}

          {selKind==="holiday"?(
            <div className="rounded-2xl border border-sky-200 bg-sky-50 p-4">
              <p className="text-sm font-semibold text-sky-900 mb-1">Company holiday</p>
              <p className="text-xs text-sky-700 mb-3">{holidayLabel(selected,settings)} · not deducted from your leave quota.</p>
              <button onClick={()=>{removeCompanyHoliday(selKey);setSelected(null);}} className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white border border-sky-300 text-sky-700 font-semibold text-sm"><Trash2 className="w-4 h-4"/> Remove holiday</button>
            </div>
          ):selKind!=="sunday"&&(
            <div className="rounded-2xl border border-slate-200 p-4">
              <p className="text-sm font-semibold text-slate-800 mb-2">Mark as company holiday</p>
              <input type="text" value={holidayLabelInput} onChange={e=>setHolidayLabelInput(e.target.value)} placeholder="Reason (e.g. Diwali, shifted Saturday)" className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-sky-500"/>
              <button onClick={()=>{addCompanyHoliday(selKey,holidayLabelInput);setHolidayLabelInput("");}} className="w-full mt-3 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-sky-500 hover:bg-sky-600 text-white font-semibold text-sm"><PartyPopper className="w-4 h-4"/> Add company holiday</button>
              <p className="text-[11px] text-slate-400 mt-2">Company holidays don't touch your 20-leave quota and reduce expected working days.</p>
            </div>
          )}
        </div>
      )}
      <div className="rounded-3xl bg-white border border-slate-200 p-5"><h3 className="font-bold text-slate-900 mb-3">Summary · {monthLabel(year,month)}</h3><div className="grid grid-cols-2 sm:grid-cols-5 gap-3"><Tile label="Working Days" value={monthStats.totalWorkingDays} tone="sky"/><Tile label="Worked" value={monthStats.workedDays} tone="emerald"/><Tile label="Leaves" value={monthStats.leavesTaken} tone="amber"/><Tile label="Co. Holidays" value={monthStats.companyHolidays} tone="sky"/><Tile label="Total Hours" value={formatHMNoSign(monthStats.totalMinutes)} tone="violet"/></div></div>
    </div>
  );
}

/* ============================================================
   LEAVES VIEW
   ============================================================ */
function LeavesView({logs,settings,leavesUsed,leavesRemaining,addLeave,removeLeave}) {
  const today=new Date(), [pickDate,setPickDate]=useState(todayKey());
  const fyStart=fyStartFor(today), fyEnd=fyEndFor(today);
  const leaves=useMemo(()=>Object.values(logs).filter(l=>{ if(l.status!=="leave") return false; const d=parseKey(l.date); return d>=fyStart&&d<=fyEnd&&!isOff(d,settings); }).sort((a,b)=>a.date.localeCompare(b.date)),[logs,settings]);
  const upcoming=leaves.filter(l=>parseKey(l.date)>=new Date(new Date().setHours(0,0,0,0)));
  const past=leaves.filter(l=>parseKey(l.date)<new Date(new Date().setHours(0,0,0,0)));
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
      <section className="lg:col-span-1 space-y-5">
        <div className="rounded-3xl bg-white border border-slate-200 p-5">
          <h2 className="font-bold text-slate-900">Leave Balance</h2><p className="text-xs text-slate-500 mt-0.5">{fyLabel(today)}</p>
          <div className="flex justify-center my-5"><ProgressRing progress={leavesUsed/ANNUAL_LEAVES} size={180} stroke={14} color="#8b5cf6" track="#f3e8ff"><div className="text-xs font-medium text-slate-500">Used</div><div className="text-4xl font-bold font-mono">{leavesUsed}</div><div className="text-xs text-slate-400">of {ANNUAL_LEAVES}</div></ProgressRing></div>
          <div className="grid grid-cols-2 gap-3"><div className="text-center p-3 rounded-xl bg-slate-50"><p className="text-xs text-slate-500">Remaining</p><p className="text-2xl font-bold font-mono text-emerald-600">{leavesRemaining}</p></div><div className="text-center p-3 rounded-xl bg-slate-50"><p className="text-xs text-slate-500">Used</p><p className="text-2xl font-bold font-mono text-violet-600">{leavesUsed}</p></div></div>
        </div>
        <div className="rounded-3xl bg-white border border-slate-200 p-5">
          <h3 className="font-bold text-slate-900 mb-4">Add Leave</h3>
          <label className="block text-xs font-semibold text-slate-700 mb-2">Select date</label>
          <input type="date" value={pickDate} min={todayKey()} onChange={e=>setPickDate(e.target.value)} className="w-full px-4 py-3 rounded-xl border border-slate-200 font-mono focus:outline-none focus:border-emerald-500"/>
          <button onClick={()=>addLeave(pickDate)} className="w-full mt-3 px-4 py-3 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white font-semibold text-sm flex items-center justify-center gap-2"><Plus className="w-4 h-4"/> Mark as leave</button>
          <p className="text-[11px] text-slate-500 mt-3">Leaves can't be applied on Sundays, off Saturdays, company holidays, or past dates. Company holidays never use up your quota — add those from the Calendar or Settings.</p>
        </div>
      </section>
      <section className="lg:col-span-2 space-y-5">
        <div className="rounded-3xl bg-white border border-slate-200 p-5"><h3 className="font-bold text-slate-900 mb-3">Upcoming Leaves</h3>{upcoming.length===0?<p className="text-sm text-slate-500 py-6 text-center">No upcoming leaves.</p>:<ul className="divide-y divide-slate-100">{upcoming.map(l=><li key={l.date} className="flex items-center justify-between py-3"><p className="font-semibold text-sm text-slate-900">{shortDate(parseKey(l.date))}</p><button onClick={()=>removeLeave(l.date)} className="p-2 rounded-lg hover:bg-rose-50 text-rose-500"><Trash2 className="w-4 h-4"/></button></li>)}</ul>}</div>
        <div className="rounded-3xl bg-white border border-slate-200 p-5"><h3 className="font-bold text-slate-900 mb-3">Leaves Taken</h3>{past.length===0?<p className="text-sm text-slate-500 py-6 text-center">None yet this FY.</p>:<ul className="divide-y divide-slate-100">{past.map(l=><li key={l.date} className="flex items-center justify-between py-3"><p className="font-semibold text-sm text-slate-900">{shortDate(parseKey(l.date))}</p><Pill tone="amber">Used</Pill></li>)}</ul>}</div>
      </section>
    </div>
  );
}

/* ============================================================
   HISTORY VIEW
   ============================================================ */
function HistoryView({logs,exportCSV,onRequestCorrection}) {
  const sorted=useMemo(()=>Object.values(logs).sort((a,b)=>b.date.localeCompare(a.date)),[logs]);
  return (
    <div className="rounded-3xl bg-white border border-slate-200 p-5">
      <div className="flex items-center justify-between mb-4"><h2 className="font-bold text-slate-900">Full History</h2><button onClick={exportCSV} className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-xs font-semibold"><Download className="w-3.5 h-3.5"/> Export CSV</button></div>
      {sorted.length===0?<p className="text-sm text-slate-500 py-12 text-center">No entries yet.</p>:(
        <>
          <div className="sm:hidden divide-y divide-slate-100">{sorted.map(l=>(<div key={l.date} className="py-1"><RecentRow log={l}/><button onClick={()=>onRequestCorrection(l.date)} className="mb-2 ml-1 flex items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-slate-800"><FileEdit className="w-3.5 h-3.5"/> Request correction</button></div>))}</div>
          <div className="hidden sm:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs font-bold uppercase tracking-wider text-slate-400 border-b border-slate-200"><th className="py-3 pr-4">Date</th><th className="py-3 pr-4">Status</th><th className="py-3 pr-4">Check-in</th><th className="py-3 pr-4">Check-out</th><th className="py-3 pr-4 text-right">Total</th><th className="py-3 pr-4 text-right">Δ target</th><th className="py-3"></th></tr></thead>
              <tbody className="divide-y divide-slate-100">{sorted.map(l=>{ const d=parseKey(l.date),surplus=l.status==="working"?l.totalMinutes-TARGET_MINUTES:null; return (<tr key={l.date}><td className="py-3 pr-4 font-medium text-slate-900">{shortDate(d)}</td><td className="py-3 pr-4">{l.status==="leave"?<Pill tone="amber">Leave</Pill>:<Pill tone="emerald">Working</Pill>}</td><td className="py-3 pr-4 font-mono text-slate-600">{l.checkIn?formatTime12(l.checkIn):"–"}</td><td className="py-3 pr-4 font-mono text-slate-600">{l.checkOut?formatTime12(l.checkOut):"–"}</td><td className="py-3 pr-4 text-right font-mono font-semibold">{l.totalMinutes!=null?formatHMNoSign(l.totalMinutes):"–"}</td><td className={`py-3 pr-4 text-right font-mono font-semibold ${surplus==null?"text-slate-400":surplus>=0?"text-emerald-600":"text-rose-600"}`}>{surplus==null?"–":formatHM(surplus)}</td><td className="py-3 text-right"><button onClick={()=>onRequestCorrection(l.date)} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-xs font-semibold text-slate-600"><FileEdit className="w-3.5 h-3.5"/> Correct</button></td></tr>); })}</tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/* ============================================================
   REQUESTS VIEW (user) — backfill forgotten records + correction requests
   ============================================================ */
const STATUS_TONE={pending:"amber",approved:"emerald",rejected:"rose",cancelled:"slate",superseded:"slate"};
function RequestsView({user,logs,settings,myRequests,correctionTarget,clearCorrectionTarget,addPastAttendance,addLeave}) {
  const [rTab,setRTab]=useState(correctionTarget?"correct":"backfill");
  // Backfill state
  const [bfDate,setBfDate]=useState(todayKey());
  const [bfType,setBfType]=useState("attendance");
  const [bfIn,setBfIn]=useState("09:30");
  const [bfOut,setBfOut]=useState("18:00");
  const [bfMsg,setBfMsg]=useState(null);
  // Correction state
  const [cDate,setCDate]=useState(correctionTarget||todayKey());
  const [cType,setCType]=useState("check_in");
  const [cValue,setCValue]=useState("");
  const [cReason,setCReason]=useState("");
  const [cMsg,setCMsg]=useState(null);
  const [submitting,setSubmitting]=useState(false);

  useEffect(()=>{ if(correctionTarget){ setRTab("correct"); setCDate(correctionTarget); } },[correctionTarget]);

  const existing=logs[cDate];
  const currentValueForType=(type,dateStr)=>{
    const l=logs[dateStr]; if(!l) return null;
    if(type==="check_in") return l.checkIn?formatTime12(l.checkIn):null;
    if(type==="check_out") return l.checkOut?formatTime12(l.checkOut):null;
    if(type==="status") return l.status;
    return null;
  };

  const doBackfill=()=>{
    setBfMsg(null);
    if(bfType==="attendance"){
      const res=addPastAttendance(bfDate,bfIn,bfOut);
      setBfMsg(res.ok?{ok:true,text:"Attendance recorded."}:{ok:false,text:res.msg});
    } else {
      // leave backfill uses existing addLeave (it alerts on failure); do a light pre-check for messaging
      const elig=backfillEligibility(bfDate);
      if(elig==="future"){setBfMsg({ok:false,text:"You can't record leave for a future date."});return;}
      if(elig==="request"){setBfMsg({ok:false,text:`That date is more than ${BACKFILL_WINDOW_DAYS} days old — use a correction request below.`});return;}
      addLeave(bfDate);
      setBfMsg({ok:true,text:"If the day was eligible, your leave is now recorded. Check the Calendar to confirm."});
    }
  };

  const submitRequest=async()=>{
    setCMsg(null);
    if(!cReason.trim()){setCMsg({ok:false,text:"Please give a reason for the correction."});return;}
    if((cType==="check_in"||cType==="check_out"||cType==="status"||cType==="leave_type")&&!existing){setCMsg({ok:false,text:"There's no record on that date to correct. Use the Backfill tab to add one, or pick 'Add forgotten…' as the type."});return;}
    if(!cValue.trim() && cType!=="other"){setCMsg({ok:false,text:"Enter the corrected value."});return;}
    // block a duplicate pending request on the same date+type
    if(myRequests.some(r=>r.status==="pending"&&r.targetDate===cDate&&r.correctionType===cType)){setCMsg({ok:false,text:"You already have a pending request for this date and field."});return;}
    setSubmitting(true);
    try {
      await submitCorrectionRequest(user,{targetDate:cDate,correctionType:cType,currentValue:currentValueForType(cType,cDate),requestedValue:cValue,reason:cReason});
      setCMsg({ok:true,text:"Request submitted. You'll see it below and the admin will review it."});
      setCValue(""); setCReason(""); clearCorrectionTarget();
    } catch(e){ console.error(e); setCMsg({ok:false,text:"Couldn't submit — check your connection."}); }
    setSubmitting(false);
  };

  const cancel=async(id)=>{ try{ await cancelCorrectionRequest(id); }catch(e){console.error(e);} };
  const tabStyle=(id)=>`px-4 py-2 rounded-xl text-sm font-semibold transition ${rTab===id?"bg-slate-900 text-white":"text-slate-600 hover:bg-slate-100"}`;

  return (
    <div className="space-y-5">
      <div className="flex gap-2 bg-slate-100 p-1.5 rounded-2xl w-fit">
        <button className={tabStyle("backfill")} onClick={()=>setRTab("backfill")}>Add Forgotten</button>
        <button className={tabStyle("correct")} onClick={()=>setRTab("correct")}>Request Correction</button>
      </div>

      {rTab==="backfill"&&(
        <section className="rounded-3xl bg-white border border-slate-200 p-5 max-w-xl">
          <h2 className="font-bold text-slate-900">Add a forgotten record</h2>
          <p className="text-xs text-slate-500 mt-0.5 mb-4">For empty days within the last {BACKFILL_WINDOW_DAYS} days — no approval needed. Older days go through a correction request.</p>
          <div className="flex gap-2 mb-4">
            <button onClick={()=>setBfType("attendance")} className={`flex-1 px-4 py-2.5 rounded-xl border text-sm font-semibold ${bfType==="attendance"?"border-emerald-500 bg-emerald-50 text-emerald-700":"border-slate-200 text-slate-600"}`}>Attendance</button>
            <button onClick={()=>setBfType("leave")} className={`flex-1 px-4 py-2.5 rounded-xl border text-sm font-semibold ${bfType==="leave"?"border-amber-500 bg-amber-50 text-amber-700":"border-slate-200 text-slate-600"}`}>Leave</button>
          </div>
          <label className="block text-xs font-semibold text-slate-700 mb-1.5">Date</label>
          <input type="date" max={todayKey()} value={bfDate} onChange={e=>setBfDate(e.target.value)} className="w-full px-4 py-3 rounded-xl border border-slate-200 font-mono focus:outline-none focus:border-emerald-500"/>
          {bfType==="attendance"&&(
            <div className="grid grid-cols-2 gap-3 mt-3">
              <div><label className="block text-xs font-semibold text-slate-700 mb-1.5">Check-in</label><input type="time" value={bfIn} onChange={e=>setBfIn(e.target.value)} className="w-full px-4 py-3 rounded-xl border border-slate-200 font-mono focus:outline-none focus:border-emerald-500"/></div>
              <div><label className="block text-xs font-semibold text-slate-700 mb-1.5">Check-out</label><input type="time" value={bfOut} onChange={e=>setBfOut(e.target.value)} className="w-full px-4 py-3 rounded-xl border border-slate-200 font-mono focus:outline-none focus:border-emerald-500"/></div>
            </div>
          )}
          <button onClick={doBackfill} className="w-full mt-4 px-4 py-3 rounded-xl bg-slate-900 text-white font-semibold text-sm">Add record</button>
          {bfMsg&&<div className={`mt-3 rounded-xl px-3 py-2 text-sm ${bfMsg.ok?"bg-emerald-50 text-emerald-700 border border-emerald-200":"bg-rose-50 text-rose-700 border border-rose-200"}`}>{bfMsg.text}</div>}
        </section>
      )}

      {rTab==="correct"&&(
        <section className="rounded-3xl bg-white border border-slate-200 p-5 max-w-xl">
          <h2 className="font-bold text-slate-900">Request a correction</h2>
          <p className="text-xs text-slate-500 mt-0.5 mb-4">Existing records can't be edited directly. Your request goes to the admin for review.</p>
          <label className="block text-xs font-semibold text-slate-700 mb-1.5">Date</label>
          <input type="date" max={todayKey()} value={cDate} onChange={e=>setCDate(e.target.value)} className="w-full px-4 py-3 rounded-xl border border-slate-200 font-mono focus:outline-none focus:border-emerald-500"/>
          {existing?<p className="text-[11px] text-slate-500 mt-1.5">Current: {existing.status}{existing.checkIn?` · in ${formatTime12(existing.checkIn)}`:""}{existing.checkOut?` · out ${formatTime12(existing.checkOut)}`:""}</p>:<p className="text-[11px] text-amber-600 mt-1.5">No record on this date yet.</p>}
          <label className="block text-xs font-semibold text-slate-700 mb-1.5 mt-3">What needs correcting?</label>
          <select value={cType} onChange={e=>setCType(e.target.value)} className="w-full px-4 py-3 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-emerald-500 bg-white">
            {Object.entries(CORRECTION_TYPES).map(([k,v])=><option key={k} value={k}>{v}</option>)}
          </select>
          {cType!=="other"&&(<>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5 mt-3">Corrected value</label>
            <input type={cType==="check_in"||cType==="check_out"?"time":"text"} value={cValue} onChange={e=>setCValue(e.target.value)} placeholder={cType==="status"?"working / leave":cType==="leave_add"?"leave":"Corrected value"} className="w-full px-4 py-3 rounded-xl border border-slate-200 text-sm font-mono focus:outline-none focus:border-emerald-500"/>
          </>)}
          <label className="block text-xs font-semibold text-slate-700 mb-1.5 mt-3">Reason</label>
          <textarea value={cReason} onChange={e=>setCReason(e.target.value)} rows={2} placeholder="Why does this need to change?" className="w-full px-4 py-3 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-emerald-500 resize-none"/>
          <button onClick={submitRequest} disabled={submitting} className="w-full mt-4 px-4 py-3 rounded-xl bg-slate-900 text-white font-semibold text-sm disabled:opacity-50 flex items-center justify-center gap-2">{submitting&&<Loader2 className="w-4 h-4 animate-spin"/>}Submit request</button>
          {cMsg&&<div className={`mt-3 rounded-xl px-3 py-2 text-sm ${cMsg.ok?"bg-emerald-50 text-emerald-700 border border-emerald-200":"bg-rose-50 text-rose-700 border border-rose-200"}`}>{cMsg.text}</div>}
        </section>
      )}

      <section className="rounded-3xl bg-white border border-slate-200 p-5">
        <h2 className="font-bold text-slate-900 mb-3">My requests</h2>
        {myRequests.length===0?<p className="text-sm text-slate-500 py-6 text-center">No requests yet.</p>:(
          <ul className="divide-y divide-slate-100">
            {myRequests.map(r=>(
              <li key={r.id} className="py-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap"><span className="font-semibold text-sm text-slate-900">{CORRECTION_TYPES[r.correctionType]||r.correctionType}</span><Pill tone={STATUS_TONE[r.status]||"slate"}>{r.status}</Pill></div>
                  <p className="text-xs text-slate-500 mt-0.5">{shortDate(parseKey(r.targetDate))}{r.requestedValue?` → ${r.requestedValue}`:""}</p>
                  {r.reason&&<p className="text-xs text-slate-400 mt-0.5 italic truncate">"{r.reason}"</p>}
                  {r.adminComment&&<p className="text-xs text-slate-600 mt-1">Admin: {r.adminComment}</p>}
                </div>
                {r.status==="pending"&&<button onClick={()=>cancel(r.id)} className="shrink-0 px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-semibold text-slate-600 hover:bg-slate-50">Cancel</button>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/* ============================================================
   ADMIN VIEW
   ============================================================ */
function AdminView({ adminUser, requests, settings }) {
  const [aTab,setATab]=useState("requests");
  const [users,setUsers]=useState([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [statusFilter,setStatusFilter]=useState("pending");
  const [reviewing,setReviewing]=useState(null);     // request being reviewed
  const [adminComment,setAdminComment]=useState("");
  const [busy,setBusy]=useState(false);
  const [selectedUser,setSelectedUser]=useState(null);   // for Users detail + direct edit

  const auditEntries=useAuditLog(adminUser,true,selectedUser?.id||null);

  const loadUsers=async()=>{
    try { setError(""); const snap=await getDocs(collection(db,"users")); setUsers(snap.docs.map(d=>({id:d.id,...d.data()}))); }
    catch(err){ console.error(err); setError(err.message||"Failed to load users."); }
    finally{ setLoading(false); }
  };
  useEffect(()=>{ loadUsers(); },[]);

  const filtered=useMemo(()=>requests.filter(r=>statusFilter==="all"?true:r.status===statusFilter),[requests,statusFilter]);
  const counts=useMemo(()=>{ const c={pending:0,approved:0,rejected:0,cancelled:0,superseded:0}; requests.forEach(r=>{c[r.status]=(c[r.status]||0)+1;}); return c; },[requests]);

  // Build the nextLogs for an approved request by applying the requested change.
  const buildNextLogs=(req,targetUser)=>{
    const logs={...(targetUser.logs||{})};
    const day={...(logs[req.targetDate]||{date:req.targetDate})};
    switch(req.correctionType){
      case "check_in": { const [h,m]=(req.requestedValue||"").replace(/[^0-9:]/g,"").split(":").map(Number); if(!isNaN(h)){ const d=parseKey(req.targetDate); d.setHours(h,m||0,0,0); day.checkIn=d.toISOString(); if(day.checkOut){day.totalMinutes=Math.max(0,Math.round((new Date(day.checkOut)-d)/60000));} day.status="working"; } break; }
      case "check_out": { const [h,m]=(req.requestedValue||"").replace(/[^0-9:]/g,"").split(":").map(Number); if(!isNaN(h)){ const d=parseKey(req.targetDate); d.setHours(h,m||0,0,0); day.checkOut=d.toISOString(); if(day.checkIn){day.totalMinutes=Math.max(0,Math.round((d-new Date(day.checkIn))/60000));} day.status="working"; } break; }
      case "status": { day.status=(req.requestedValue||"").toLowerCase().includes("leave")?"leave":"working"; if(day.status==="leave"){delete day.checkIn;delete day.checkOut;delete day.totalMinutes;} break; }
      case "leave_add": { day.status="leave"; delete day.checkIn; delete day.checkOut; delete day.totalMinutes; break; }
      case "attendance_add": break; // free-form; admin should use direct edit for precise times
      default: break;
    }
    logs[req.targetDate]=day;
    return logs;
  };

  const decide=async(approve)=>{
    if(!reviewing) return;
    setBusy(true);
    try {
      let applyToLogs=null;
      if(approve){
        const targetUser=users.find(u=>u.id===reviewing.userId);
        if(targetUser && ["check_in","check_out","status","leave_add"].includes(reviewing.correctionType)){
          applyToLogs={nextLogs:buildNextLogs(reviewing,targetUser)};
        }
      }
      await decideCorrectionRequest({request:reviewing,approve,adminUser,adminComment,applyToLogs});
      await loadUsers();
      setReviewing(null); setAdminComment("");
    } catch(e){ console.error(e); setError("Couldn't apply the decision. Nothing was changed."); }
    setBusy(false);
  };

  const tabStyle=(id)=>`px-4 py-2 rounded-xl text-sm font-semibold transition ${aTab===id?"bg-slate-900 text-white":"text-slate-600 hover:bg-slate-100"}`;
  const filterStyle=(id)=>`px-3 py-1.5 rounded-lg text-xs font-semibold ${statusFilter===id?"bg-slate-900 text-white":"bg-slate-100 text-slate-600"}`;

  return (
    <div className="space-y-5">
      <div className="flex gap-2 bg-slate-100 p-1.5 rounded-2xl w-fit overflow-x-auto">
        <button className={tabStyle("requests")} onClick={()=>setATab("requests")}><span className="flex items-center gap-1.5"><ClipboardList className="w-4 h-4"/>Requests{counts.pending>0&&<span className="min-w-[18px] h-[18px] px-1 rounded-full bg-rose-500 text-white text-[10px] font-bold grid place-items-center">{counts.pending}</span>}</span></button>
        <button className={tabStyle("users")} onClick={()=>{setATab("users");setSelectedUser(null);}}><span className="flex items-center gap-1.5"><Users className="w-4 h-4"/>Users</span></button>
        <button className={tabStyle("audit")} onClick={()=>{setATab("audit");setSelectedUser(null);}}><span className="flex items-center gap-1.5"><ScrollText className="w-4 h-4"/>Audit Log</span></button>
      </div>

      {error&&<div className="rounded-xl bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">{error}</div>}

      {/* ── REQUESTS ── */}
      {aTab==="requests"&&(
        <section className="rounded-3xl bg-white border border-slate-200 p-5">
          <div className="flex items-center gap-2 mb-4 flex-wrap">
            {["pending","approved","rejected","all"].map(s=><button key={s} onClick={()=>setStatusFilter(s)} className={filterStyle(s)}>{s[0].toUpperCase()+s.slice(1)}{s!=="all"&&counts[s]>0?` (${counts[s]})`:""}</button>)}
          </div>
          {filtered.length===0?<p className="text-sm text-slate-500 py-8 text-center">No {statusFilter==="all"?"":statusFilter} requests.</p>:(
            <ul className="divide-y divide-slate-100">
              {filtered.map(r=>(
                <li key={r.id} className="py-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap"><span className="font-semibold text-sm text-slate-900">{r.userName||r.userEmail}</span><Pill tone={STATUS_TONE[r.status]||"slate"}>{r.status}</Pill></div>
                    <p className="text-xs text-slate-600 mt-0.5">{CORRECTION_TYPES[r.correctionType]||r.correctionType} · {shortDate(parseKey(r.targetDate))}</p>
                    <p className="text-xs text-slate-500 mt-0.5">{r.currentValue?`${r.currentValue} `:""}→ {r.requestedValue||"(see reason)"}</p>
                    {r.reason&&<p className="text-xs text-slate-400 mt-0.5 italic">"{r.reason}"</p>}
                  </div>
                  {r.status==="pending"
                    ? <button onClick={()=>{setReviewing(r);setAdminComment("");}} className="shrink-0 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-semibold">Review</button>
                    : r.adminComment?<p className="shrink-0 text-xs text-slate-400 max-w-[40%]">Note: {r.adminComment}</p>:null}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* ── USERS ── */}
      {aTab==="users"&&!selectedUser&&(
        <section className="rounded-3xl bg-white border border-slate-200 p-5">
          <h2 className="font-bold text-slate-900 mb-3">All Users</h2>
          {loading?<p className="text-sm text-slate-500">Loading…</p>:users.length===0?<p className="text-sm text-slate-500">No users found.</p>:(
            <ul className="divide-y divide-slate-100">
              {users.map(u=>{ const logCount=Object.keys(u.logs||{}).length; return (
                <li key={u.id} className="py-3 flex items-center justify-between gap-3">
                  <div className="min-w-0"><p className="font-semibold text-sm text-slate-900 truncate">{u.name||u.email||u.id}</p><p className="text-xs text-slate-500 truncate">{u.email||"No email"} · {logCount} record{logCount!==1?"s":""}{isAdminEmail(u.email)&&<span className="ml-1 text-emerald-600 font-semibold">· admin</span>}</p></div>
                  <button onClick={()=>setSelectedUser(u)} className="shrink-0 px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-semibold text-slate-600 hover:bg-slate-50">View</button>
                </li>
              ); })}
            </ul>
          )}
        </section>
      )}

      {aTab==="users"&&selectedUser&&(
        <AdminUserDetail user={selectedUser} adminUser={adminUser} settings={settings} requests={requests} auditEntries={auditEntries} onBack={()=>setSelectedUser(null)} onEdited={loadUsers}/>
      )}

      {/* ── AUDIT ── */}
      {aTab==="audit"&&(
        <section className="rounded-3xl bg-white border border-slate-200 p-5">
          <h2 className="font-bold text-slate-900 mb-3">Audit Log</h2>
          <p className="text-xs text-slate-500 -mt-2 mb-4">Every applied change, append-only.</p>
          <AuditList entries={auditEntries} users={users}/>
        </section>
      )}

      {/* ── REVIEW MODAL ── */}
      <Modal open={!!reviewing} onClose={()=>!busy&&setReviewing(null)} title="Review request">
        {reviewing&&(
          <div>
            <div className="rounded-2xl bg-slate-50 border border-slate-200 p-4 mb-4 space-y-1.5">
              <p className="text-sm"><span className="text-slate-500">User:</span> <span className="font-semibold">{reviewing.userName||reviewing.userEmail}</span></p>
              <p className="text-sm"><span className="text-slate-500">Date:</span> <span className="font-semibold">{shortDate(parseKey(reviewing.targetDate))}</span></p>
              <p className="text-sm"><span className="text-slate-500">Type:</span> <span className="font-semibold">{CORRECTION_TYPES[reviewing.correctionType]||reviewing.correctionType}</span></p>
              <p className="text-sm"><span className="text-slate-500">Change:</span> <span className="font-mono">{reviewing.currentValue||"—"} → {reviewing.requestedValue||"(see reason)"}</span></p>
              <p className="text-sm"><span className="text-slate-500">Reason:</span> {reviewing.reason||"—"}</p>
            </div>
            {!["check_in","check_out","status","leave_add"].includes(reviewing.correctionType)&&(
              <div className="rounded-xl bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800 mb-3">This type can't be auto-applied. Approving records the decision + audit entry; make the actual change via Users → direct edit.</div>
            )}
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">Comment (optional)</label>
            <textarea value={adminComment} onChange={e=>setAdminComment(e.target.value)} rows={2} className="w-full px-4 py-3 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-emerald-500 resize-none mb-4" placeholder="Visible to the user"/>
            <div className="grid grid-cols-2 gap-2">
              <button disabled={busy} onClick={()=>decide(false)} className="px-4 py-2.5 rounded-xl border border-rose-200 text-rose-700 font-semibold text-sm disabled:opacity-50 flex items-center justify-center gap-2"><XCircle className="w-4 h-4"/>Reject</button>
              <button disabled={busy} onClick={()=>decide(true)} className="px-4 py-2.5 rounded-xl bg-emerald-500 text-white font-semibold text-sm disabled:opacity-50 flex items-center justify-center gap-2">{busy?<Loader2 className="w-4 h-4 animate-spin"/>:<Check className="w-4 h-4"/>}Approve</button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function AuditList({entries,users}) {
  const nameFor=(uid)=>{ const u=users?.find(x=>x.id===uid); return u?.name||u?.email||uid?.slice(0,6); };
  if(!entries||entries.length===0) return <p className="text-sm text-slate-500 py-8 text-center">No audit entries yet.</p>;
  return (
    <ul className="divide-y divide-slate-100">
      {entries.map(e=>(
        <li key={e.id} className="py-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-sm text-slate-900">{CORRECTION_TYPES[e.field]||e.field}</span>
            <Pill tone={e.source==="admin_direct_edit"?"violet":e.source==="user_backfill"?"sky":"emerald"}>{e.source==="admin_direct_edit"?"admin edit":e.source==="user_backfill"?"backfill":"request"}</Pill>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">{users?`${nameFor(e.userId)} · `:""}{shortDate(parseKey(e.targetDate))} · {e.originalValue??"—"} → {e.newValue??"—"}</p>
          {e.actingAdmin&&<p className="text-[11px] text-slate-400 mt-0.5">by {e.actingAdmin}</p>}
        </li>
      ))}
    </ul>
  );
}

function AdminUserDetail({user,adminUser,settings,requests,auditEntries,onBack,onEdited}) {
  const logs=user.logs||{};
  const sorted=useMemo(()=>Object.values(logs).sort((a,b)=>b.date.localeCompare(a.date)),[logs]);
  const [editing,setEditing]=useState(null);   // date being edited
  const [eStatus,setEStatus]=useState("working");
  const [eIn,setEIn]=useState("09:30");
  const [eOut,setEOut]=useState("18:00");
  const [busy,setBusy]=useState(false);
  const [msg,setMsg]=useState(null);

  const openEdit=(l)=>{
    setEditing(l.date); setMsg(null);
    setEStatus(l.status||"working");
    setEIn(l.checkIn?`${pad(new Date(l.checkIn).getHours())}:${pad(new Date(l.checkIn).getMinutes())}`:"09:30");
    setEOut(l.checkOut?`${pad(new Date(l.checkOut).getHours())}:${pad(new Date(l.checkOut).getMinutes())}`:"18:00");
  };

  const saveEdit=async()=>{
    setBusy(true); setMsg(null);
    try {
      const orig=logs[editing];
      const nextLogs={...logs};
      const day={date:editing,status:eStatus};
      if(eStatus==="working"){
        const [ih,im]=eIn.split(":").map(Number),[oh,om]=eOut.split(":").map(Number);
        const ci=parseKey(editing); ci.setHours(ih,im,0,0);
        const co=parseKey(editing); co.setHours(oh,om,0,0);
        if(co<=ci){ setMsg("Check-out must be after check-in."); setBusy(false); return; }
        day.checkIn=ci.toISOString(); day.checkOut=co.toISOString(); day.totalMinutes=Math.round((co-ci)/60000);
      }
      nextLogs[editing]=day;
      const pending=requests.filter(r=>r.userId===user.id&&r.targetDate===editing&&r.status==="pending").map(r=>r.id);
      await adminDirectEdit({
        targetUserId:user.id, nextLogs, field:"admin_edit",
        originalValue:orig?`${orig.status}${orig.checkIn?" "+formatTime12(orig.checkIn):""}`:"(none)",
        newValue:`${day.status}${day.checkIn?" "+formatTime12(day.checkIn):""}`,
        targetDate:editing, adminUser, pendingToSupersede:pending,
      });
      setEditing(null); onEdited&&await onEdited();
    } catch(e){ console.error(e); setMsg("Couldn't save — nothing was changed."); }
    setBusy(false);
  };

  return (
    <section className="rounded-3xl bg-white border border-slate-200 p-5">
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm font-semibold text-slate-500 hover:text-slate-800 mb-4"><ChevronLeft className="w-4 h-4"/>All users</button>
      <h2 className="font-bold text-slate-900">{user.name||user.email}</h2>
      <p className="text-xs text-slate-500 mt-0.5 mb-4">{user.email} · {sorted.length} records</p>

      {sorted.length===0?<p className="text-sm text-slate-500 py-6 text-center">No attendance records.</p>:(
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs font-bold uppercase tracking-wider text-slate-400 border-b border-slate-200"><th className="py-2 pr-4">Date</th><th className="py-2 pr-4">Status</th><th className="py-2 pr-4">In</th><th className="py-2 pr-4">Out</th><th className="py-2 pr-4 text-right">Total</th><th className="py-2"></th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {sorted.map(l=>(
                <tr key={l.date}>
                  <td className="py-2.5 pr-4 font-medium text-slate-900">{shortDate(parseKey(l.date))}</td>
                  <td className="py-2.5 pr-4">{l.status==="leave"?<Pill tone="amber">Leave</Pill>:<Pill tone="emerald">Working</Pill>}</td>
                  <td className="py-2.5 pr-4 font-mono text-slate-600">{l.checkIn?formatTime12(l.checkIn):"–"}</td>
                  <td className="py-2.5 pr-4 font-mono text-slate-600">{l.checkOut?formatTime12(l.checkOut):"–"}</td>
                  <td className="py-2.5 pr-4 text-right font-mono">{l.totalMinutes!=null?formatHMNoSign(l.totalMinutes):"–"}</td>
                  <td className="py-2.5 text-right"><button onClick={()=>openEdit(l)} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-xs font-semibold text-slate-600"><Pencil className="w-3.5 h-3.5"/>Edit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={!!editing} onClose={()=>!busy&&setEditing(null)} title={`Edit ${editing?shortDate(parseKey(editing)):""}`}>
        <div>
          <div className="rounded-xl bg-violet-50 border border-violet-200 px-3 py-2 text-xs text-violet-800 mb-4">Direct edits are logged to the audit trail and supersede any pending request on this date.</div>
          <label className="block text-xs font-semibold text-slate-700 mb-1.5">Status</label>
          <div className="flex gap-2 mb-3">
            <button onClick={()=>setEStatus("working")} className={`flex-1 px-4 py-2.5 rounded-xl border text-sm font-semibold ${eStatus==="working"?"border-emerald-500 bg-emerald-50 text-emerald-700":"border-slate-200 text-slate-600"}`}>Working</button>
            <button onClick={()=>setEStatus("leave")} className={`flex-1 px-4 py-2.5 rounded-xl border text-sm font-semibold ${eStatus==="leave"?"border-amber-500 bg-amber-50 text-amber-700":"border-slate-200 text-slate-600"}`}>Leave</button>
          </div>
          {eStatus==="working"&&(
            <div className="grid grid-cols-2 gap-3">
              <div><label className="block text-xs font-semibold text-slate-700 mb-1.5">Check-in</label><input type="time" value={eIn} onChange={e=>setEIn(e.target.value)} className="w-full px-4 py-3 rounded-xl border border-slate-200 font-mono focus:outline-none focus:border-emerald-500"/></div>
              <div><label className="block text-xs font-semibold text-slate-700 mb-1.5">Check-out</label><input type="time" value={eOut} onChange={e=>setEOut(e.target.value)} className="w-full px-4 py-3 rounded-xl border border-slate-200 font-mono focus:outline-none focus:border-emerald-500"/></div>
            </div>
          )}
          {msg&&<div className="mt-3 rounded-xl bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">{msg}</div>}
          <div className="grid grid-cols-2 gap-2 mt-4">
            <button disabled={busy} onClick={()=>setEditing(null)} className="px-4 py-2.5 rounded-xl border border-slate-200 font-semibold text-sm">Cancel</button>
            <button disabled={busy} onClick={saveEdit} className="px-4 py-2.5 rounded-xl bg-slate-900 text-white font-semibold text-sm disabled:opacity-50 flex items-center justify-center gap-2">{busy&&<Loader2 className="w-4 h-4 animate-spin"/>}Save</button>
          </div>
        </div>
      </Modal>
    </section>
  );
}

/* ============================================================
   SETTINGS VIEW — Off days + Alarms
   ============================================================ */
function SettingsView({settings,updateSettings,toggleFirstSat,addCompanyHoliday,removeCompanyHoliday,addAlarm,updateAlarm,removeAlarm}) {
  const today=new Date();
  const [sTab,setSTab]=useState("offdays");
  const [holDate,setHolDate]=useState(todayKey());
  const [holLabel,setHolLabel]=useState("");
  const [customOffset,setCustomOffset]=useState(0);
  const [customRepeat,setCustomRepeat]=useState(0);
  const [notifState,setNotifState]=useState(()=>typeof Notification!=="undefined"?Notification.permission:"unsupported");

  const alarms=settings.alarms||[];
  const holidays=useMemo(()=>Object.entries(settings.companyHolidays||{}).map(([date,v])=>({date,label:v?.label||"Company holiday"})).sort((a,b)=>a.date.localeCompare(b.date)),[settings.companyHolidays]);
  const fyStart=fyStartFor(today), fyEnd=fyEndFor(today);
  const upcomingHolidays=holidays.filter(h=>parseKey(h.date)>=new Date(new Date().setHours(0,0,0,0)));
  const pastHolidays=holidays.filter(h=>parseKey(h.date)<new Date(new Date().setHours(0,0,0,0))&&parseKey(h.date)>=fyStart&&parseKey(h.date)<=fyEnd);

  // Next 12 months of 1st Saturdays for the override list
  const firstSats=useMemo(()=>{
    const out=[];
    for(let i=0;i<12;i++){
      const d=new Date(today.getFullYear(),today.getMonth()+i,1);
      const day=firstSaturday(d.getFullYear(),d.getMonth());
      const date=new Date(d.getFullYear(),d.getMonth(),day);
      out.push({date,mKey:monthKeyOf(d.getFullYear(),d.getMonth()),working:(settings.firstSatOverrides||{})[monthKeyOf(d.getFullYear(),d.getMonth())]==="working"});
    }
    return out;
  },[settings.firstSatOverrides]);

  const askNotify=async()=>{ const r=await requestNotifyPermission(); setNotifState(r); if(r==="granted") updateSettings({notify:true}); };
  const tabStyle=(id)=>`px-4 py-2 rounded-xl text-sm font-semibold transition ${sTab===id?"bg-slate-900 text-white":"text-slate-600 hover:bg-slate-100"}`;

  return (
    <div className="space-y-5">
      <div className="flex gap-2 bg-slate-100 p-1.5 rounded-2xl w-fit">
        <button className={tabStyle("offdays")} onClick={()=>setSTab("offdays")}>Off Days</button>
        <button className={tabStyle("alarms")} onClick={()=>setSTab("alarms")}>Alarms</button>
      </div>

      {/* ── OFF DAYS ── */}
      {sTab==="offdays"&&(
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <section className="rounded-3xl bg-white border border-slate-200 p-5">
            <h2 className="font-bold text-slate-900">Add Company Holiday</h2>
            <p className="text-xs text-slate-500 mt-0.5 mb-4">Declared by the company. Never deducted from your {ANNUAL_LEAVES}-leave quota.</p>
            <label className="block text-xs font-semibold text-slate-700 mb-2">Date</label>
            <input type="date" value={holDate} onChange={e=>setHolDate(e.target.value)} className="w-full px-4 py-3 rounded-xl border border-slate-200 font-mono focus:outline-none focus:border-sky-500"/>
            <label className="block text-xs font-semibold text-slate-700 mb-2 mt-3">Reason (optional)</label>
            <input type="text" value={holLabel} onChange={e=>setHolLabel(e.target.value)} placeholder="Diwali, shifted Saturday, founder's day…" className="w-full px-4 py-3 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-sky-500"/>
            <button onClick={()=>{addCompanyHoliday(holDate,holLabel);setHolLabel("");}} className="w-full mt-3 px-4 py-3 rounded-xl bg-sky-500 hover:bg-sky-600 text-white font-semibold text-sm flex items-center justify-center gap-2"><PartyPopper className="w-4 h-4"/> Add holiday</button>
            <p className="text-[11px] text-slate-500 mt-3">Past dates are allowed here — useful for backfilling holidays the company announced earlier.</p>
          </section>

          <section className="rounded-3xl bg-white border border-slate-200 p-5">
            <h2 className="font-bold text-slate-900">1st Saturday Rule</h2>
            <p className="text-xs text-slate-500 mt-0.5 mb-4">The 1st Saturday of every month is off by default. Flip any single month without changing the rule.</p>
            <div className="max-h-[340px] overflow-y-auto divide-y divide-slate-100 -mx-1 px-1">
              {firstSats.map(fs=>(
                <div key={fs.mKey} className="flex items-center justify-between py-2.5">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{compactDate(fs.date)} {fs.date.getFullYear()}</p>
                    <p className={`text-[11px] font-medium mt-0.5 ${fs.working?"text-sky-600":"text-slate-500"}`}>{fs.working?"Working day":"Off day"}</p>
                  </div>
                  <button onClick={()=>toggleFirstSat(fs.date.getFullYear(),fs.date.getMonth())} className={`px-3 py-1.5 rounded-lg text-xs font-semibold border ${fs.working?"bg-white border-slate-300 text-slate-700":"bg-sky-500 border-sky-500 text-white"}`}>
                    {fs.working?"Mark off":"Mark working"}
                  </button>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-3xl bg-white border border-slate-200 p-5 lg:col-span-2">
            <h2 className="font-bold text-slate-900 mb-3">Upcoming Company Holidays</h2>
            {upcomingHolidays.length===0?<p className="text-sm text-slate-500 py-6 text-center">None scheduled.</p>:(
              <ul className="divide-y divide-slate-100">
                {upcomingHolidays.map(h=>(
                  <li key={h.date} className="flex items-center justify-between py-3">
                    <div><p className="font-semibold text-sm text-slate-900">{shortDate(parseKey(h.date))}</p><p className="text-xs text-slate-500 mt-0.5">{h.label}</p></div>
                    <button onClick={()=>removeCompanyHoliday(h.date)} className="p-2 rounded-lg hover:bg-rose-50 text-rose-500"><Trash2 className="w-4 h-4"/></button>
                  </li>
                ))}
              </ul>
            )}
            {pastHolidays.length>0&&(
              <>
                <h3 className="font-bold text-slate-900 mt-6 mb-2 text-sm">Earlier this FY</h3>
                <ul className="divide-y divide-slate-100">
                  {pastHolidays.map(h=>(
                    <li key={h.date} className="flex items-center justify-between py-3">
                      <div><p className="font-semibold text-sm text-slate-700">{shortDate(parseKey(h.date))}</p><p className="text-xs text-slate-500 mt-0.5">{h.label}</p></div>
                      <button onClick={()=>removeCompanyHoliday(h.date)} className="p-2 rounded-lg hover:bg-rose-50 text-rose-400"><Trash2 className="w-4 h-4"/></button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        </div>
      )}

      {/* ── ALARMS ── */}
      {sTab==="alarms"&&(
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <section className="rounded-3xl bg-white border border-slate-200 p-5">
            <h2 className="font-bold text-slate-900">Your Alarms</h2>
            <p className="text-xs text-slate-500 mt-0.5 mb-4">Alarms are measured from your check-in time against the 8h 30m target.</p>
            {alarms.length===0?<p className="text-sm text-slate-500 py-6 text-center">No alarms yet. Add one from the presets.</p>:(
              <ul className="divide-y divide-slate-100">
                {alarms.map(a=>(
                  <li key={a.id} className="flex items-center justify-between py-3 gap-3">
                    <div className="min-w-0">
                      <p className={`font-semibold text-sm ${a.enabled?"text-slate-900":"text-slate-400"}`}>{a.label||offsetLabel(a.offsetMin)}</p>
                      <p className="text-xs text-slate-500 mt-0.5">{offsetLabel(a.offsetMin)}{a.repeatMin?` · repeats every ${a.repeatMin} min`:""}</p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button onClick={()=>updateAlarm(a.id,{enabled:!a.enabled})} className={`p-2 rounded-lg ${a.enabled?"text-emerald-600 hover:bg-emerald-50":"text-slate-300 hover:bg-slate-50"}`}>{a.enabled?<Bell className="w-4 h-4"/>:<BellOff className="w-4 h-4"/>}</button>
                      <button onClick={()=>removeAlarm(a.id)} className="p-2 rounded-lg hover:bg-rose-50 text-rose-500"><Trash2 className="w-4 h-4"/></button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <h3 className="font-bold text-slate-900 mt-6 mb-2 text-sm">Quick add</h3>
            <div className="flex flex-wrap gap-2">
              {ALARM_PRESETS.map(p=>(
                <button key={p.label} onClick={()=>addAlarm(p)} className="px-3 py-2 rounded-xl border border-slate-200 text-xs font-semibold text-slate-700 hover:bg-slate-50 flex items-center gap-1.5"><Plus className="w-3.5 h-3.5"/>{p.label}</button>
              ))}
            </div>

            <h3 className="font-bold text-slate-900 mt-6 mb-2 text-sm">Custom</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-600 mb-1.5">Minutes from target</label>
                <input type="number" value={customOffset} onChange={e=>setCustomOffset(Number(e.target.value))} step={5} className="w-full px-3 py-2.5 rounded-xl border border-slate-200 font-mono text-sm focus:outline-none focus:border-emerald-500"/>
                <p className="text-[10px] text-slate-400 mt-1">Negative = before, positive = after</p>
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-600 mb-1.5">Repeat every (min)</label>
                <input type="number" value={customRepeat} onChange={e=>setCustomRepeat(Math.max(0,Number(e.target.value)))} min={0} step={5} className="w-full px-3 py-2.5 rounded-xl border border-slate-200 font-mono text-sm focus:outline-none focus:border-emerald-500"/>
                <p className="text-[10px] text-slate-400 mt-1">0 = fire once</p>
              </div>
            </div>
            <button onClick={()=>addAlarm({label:offsetLabel(customOffset),offsetMin:customOffset,repeatMin:customRepeat})} className="w-full mt-3 px-4 py-2.5 rounded-xl bg-slate-900 text-white font-semibold text-sm flex items-center justify-center gap-2"><Plus className="w-4 h-4"/> Add custom alarm</button>
          </section>

          <section className="rounded-3xl bg-white border border-slate-200 p-5">
            <h2 className="font-bold text-slate-900">Sound & Alerts</h2>
            <p className="text-xs text-slate-500 mt-0.5 mb-4">Tones are generated in-browser — no download needed.</p>

            <label className="block text-xs font-semibold text-slate-700 mb-2">Alarm tone</label>
            <div className="grid grid-cols-2 gap-2">
              {Object.entries(ALARM_SOUNDS).map(([key,v])=>(
                <button key={key} onClick={()=>{updateSettings({alarmSound:key});playAlarmSound(key,settings.alarmVolume);}} className={`px-3 py-2.5 rounded-xl border text-xs font-semibold flex items-center justify-between ${settings.alarmSound===key?"border-emerald-500 bg-emerald-50 text-emerald-700":"border-slate-200 text-slate-700 hover:bg-slate-50"}`}>
                  {v.label}{settings.alarmSound===key&&<CheckCircle2 className="w-3.5 h-3.5"/>}
                </button>
              ))}
            </div>

            <label className="block text-xs font-semibold text-slate-700 mb-2 mt-5">Volume · {Math.round((settings.alarmVolume??0.6)*100)}%</label>
            <input type="range" min={0.05} max={1} step={0.05} value={settings.alarmVolume??0.6} onChange={e=>updateSettings({alarmVolume:Number(e.target.value)})} className="w-full accent-emerald-500"/>

            <button onClick={()=>{unlockAudio();playAlarmSound(settings.alarmSound,settings.alarmVolume);buzz(settings.vibrate);}} className="w-full mt-4 px-4 py-3 rounded-xl border border-slate-200 font-semibold text-sm text-slate-700 hover:bg-slate-50 flex items-center justify-center gap-2"><Play className="w-4 h-4"/> Test alarm</button>

            <div className="mt-5 space-y-3">
              <div className="flex items-center justify-between rounded-2xl border border-slate-200 p-4">
                <div className="min-w-0 pr-3"><p className="text-sm font-semibold text-slate-900">Vibrate</p><p className="text-xs text-slate-500 mt-0.5">On supported phones.</p></div>
                <button onClick={()=>updateSettings({vibrate:!settings.vibrate})} className={`shrink-0 w-12 h-7 rounded-full transition relative ${settings.vibrate?"bg-emerald-500":"bg-slate-300"}`}><span className={`absolute top-1 w-5 h-5 rounded-full bg-white transition-all ${settings.vibrate?"left-6":"left-1"}`}/></button>
              </div>
              <div className="flex items-center justify-between rounded-2xl border border-slate-200 p-4">
                <div className="min-w-0 pr-3"><p className="text-sm font-semibold text-slate-900">Browser notification</p><p className="text-xs text-slate-500 mt-0.5">{notifState==="granted"?"Permission granted.":notifState==="denied"?"Blocked — enable it in site settings.":"Permission needed."}</p></div>
                {notifState==="granted"
                  ? <button onClick={()=>updateSettings({notify:!settings.notify})} className={`shrink-0 w-12 h-7 rounded-full transition relative ${settings.notify?"bg-emerald-500":"bg-slate-300"}`}><span className={`absolute top-1 w-5 h-5 rounded-full bg-white transition-all ${settings.notify?"left-6":"left-1"}`}/></button>
                  : <button onClick={askNotify} className="shrink-0 px-3 py-2 rounded-lg bg-slate-900 text-white text-xs font-semibold">Enable</button>}
              </div>
            </div>

            <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 flex gap-3">
              <AlertCircle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0"/>
              <p className="text-xs text-amber-800">Alarms only ring while the app is open in a tab. If the tab was in the background, the beep fires as soon as it wakes up — up to 5 minutes late, after which it's skipped silently.</p>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   ANALYTICS VIEW — Weekly / Monthly / FY tabs
   ============================================================ */
function AnalyticsView({logs,fySurplus,settings}) {
  const today=new Date();
  const [aTab,setATab]=useState("weekly");
  const [cursor,setCursor]=useState({year:today.getFullYear(),month:today.getMonth()});
  const [fyCursor,setFyCursor]=useState(()=>fyStartFor(today).getFullYear());

  const navigate=(delta)=>{ const nm=cursor.month+delta; if(nm<0) setCursor({year:cursor.year-1,month:11}); else if(nm>11) setCursor({year:cursor.year+1,month:0}); else setCursor({year:cursor.year,month:nm}); };

  const weeks=useMemo(()=>getWeeksInMonth(cursor.year,cursor.month,logs,settings),[logs,cursor,settings]);
  const weekCumulative=useMemo(()=>{ let s=0; return weeks.map(w=>{s+=w.surplus;return s;}); },[weeks]);

  const fyMonths=useMemo(()=>{
    const arr=[];
    for(let m=3;m<=14;m++) { const month=m%12,year=m<12?fyCursor:fyCursor+1; arr.push({year,month,...getMonthlyStats(logs,year,month,settings)}); }
    return arr;
  },[logs,fyCursor,settings]);
  const fyCumulative=useMemo(()=>{ let s=0; return fyMonths.map(m=>{s+=m.surplus;return s;}); },[fyMonths]);

  const fyTotals=useMemo(()=>{
    const start=new Date(fyCursor,3,1),end=new Date(fyCursor+1,2,31);
    let totalWorked=0,workedDays=0,totalLeaves=0,totalDays=0;
    Object.values(logs).forEach(l=>{ const d=parseKey(l.date); if(d<start||d>end) return; if(l.status==="working"){totalWorked+=l.totalMinutes||0;workedDays++;}if(l.status==="leave"&&!isOff(d,settings))totalLeaves++; });
    for(let m=3;m<=14;m++){const month=m%12,year=m<12?fyCursor:fyCursor+1;totalDays+=workingDaysInMonth(year,month,settings);}
    return {totalWorked,workedDays,totalLeaves,totalDays,surplus:totalWorked-workedDays*TARGET_MINUTES};
  },[logs,fyCursor,settings]);

  const tabStyle=(id)=>`px-4 py-2 rounded-xl text-sm font-semibold transition ${aTab===id?"bg-slate-900 text-white":"text-slate-600 hover:bg-slate-100"}`;
  const curMonthStats=useMemo(()=>getMonthlyStats(logs,cursor.year,cursor.month,settings),[logs,cursor,settings]);

  return (
    <div className="space-y-5">
      <div className={`rounded-3xl p-6 border ${fySurplus>=0?"bg-gradient-to-br from-emerald-500 to-emerald-600 border-emerald-600":"bg-gradient-to-br from-rose-500 to-rose-600 border-rose-600"} text-white`}>
        <p className="text-xs font-bold uppercase tracking-wider opacity-90">FY Carry-Forward Balance</p>
        <p className="text-5xl font-bold font-mono tracking-tight mt-2">{formatHM(fySurplus)}</p>
        <p className="text-sm opacity-90 mt-2">{fyLabel(today)}</p>
      </div>

      <div className="flex gap-2 bg-slate-100 p-1.5 rounded-2xl w-fit">
        <button className={tabStyle("weekly")} onClick={()=>setATab("weekly")}>Weekly</button>
        <button className={tabStyle("monthly")} onClick={()=>setATab("monthly")}>Monthly</button>
        <button className={tabStyle("fy")} onClick={()=>setATab("fy")}>FY Summary</button>
      </div>

      {/* ── WEEKLY TAB ── */}
      {aTab==="weekly"&&(
        <div className="rounded-3xl bg-white border border-slate-200 p-5">
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-2"><button onClick={()=>navigate(-1)} className="p-2 rounded-lg hover:bg-slate-100"><ChevronLeft className="w-4 h-4"/></button><h3 className="font-bold text-slate-900 min-w-[140px] text-center">{monthLabel(cursor.year,cursor.month)}</h3><button onClick={()=>navigate(1)} className="p-2 rounded-lg hover:bg-slate-100"><ChevronRight className="w-4 h-4"/></button></div>
            <button onClick={()=>setCursor({year:today.getFullYear(),month:today.getMonth()})} className="px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-600 hover:bg-slate-100">This month</button>
          </div>
          {weeks.length===0?<p className="text-sm text-slate-500 text-center py-8">No data for this month.</p>:(
            <div className="space-y-3">
              {weeks.map((w,i)=>{
                const pct=Math.min((w.totalMinutes/(w.workingDays*TARGET_MINUTES))*100,100), isPos=w.surplus>=0;
                return (
                  <div key={w.weekNum} className="rounded-2xl border border-slate-100 p-4">
                    <div className="flex items-center justify-between mb-2">
                      <div><p className="text-sm font-bold text-slate-900">Week {w.weekNum} <span className="font-normal text-slate-500 text-xs">· {compactDate(w.startDate)} – {compactDate(w.endDate)}</span></p><p className="text-xs text-slate-500 mt-0.5">{w.workedDays}/{w.workingDays} days worked</p></div>
                      <div className="text-right"><p className="font-mono font-bold text-sm text-slate-900">{formatHMNoSign(w.totalMinutes)}</p><p className={`text-xs font-bold ${isPos?"text-emerald-600":"text-rose-600"}`}>{formatHM(w.surplus)}</p></div>
                    </div>
                    <div className="h-2 rounded-full bg-slate-100 overflow-hidden"><div className={`h-full rounded-full ${isPos?"bg-emerald-500":"bg-rose-400"}`} style={{width:`${pct}%`,transition:"width 0.5s ease"}}/></div>
                    <p className="text-[11px] text-slate-400 mt-1.5 text-right">Cumulative: <span className={`font-bold ${weekCumulative[i]>=0?"text-emerald-600":"text-rose-600"}`}>{formatHM(weekCumulative[i])}</span></p>
                  </div>
                );
              })}
              <div className={`rounded-2xl p-4 border ${curMonthStats.surplus>=0?"border-emerald-200 bg-emerald-50":"border-rose-200 bg-rose-50"}`}>
                <div className="flex items-center justify-between"><p className="text-sm font-bold text-slate-900">Month Total</p><div className="text-right"><p className="font-mono font-bold text-sm">{formatHMNoSign(curMonthStats.totalMinutes)}</p><p className={`text-xs font-bold ${curMonthStats.surplus>=0?"text-emerald-600":"text-rose-600"}`}>{formatHM(curMonthStats.surplus)}</p></div></div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── MONTHLY TAB ── */}
      {aTab==="monthly"&&(
        <div className="rounded-3xl bg-white border border-slate-200 p-5">
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-2"><button onClick={()=>setFyCursor(f=>f-1)} className="p-2 rounded-lg hover:bg-slate-100"><ChevronLeft className="w-4 h-4"/></button><h3 className="font-bold text-slate-900 min-w-[160px] text-center">Apr {fyCursor} – Mar {fyCursor+1}</h3><button onClick={()=>setFyCursor(f=>f+1)} className="p-2 rounded-lg hover:bg-slate-100"><ChevronRight className="w-4 h-4"/></button></div>
            <button onClick={()=>setFyCursor(fyStartFor(today).getFullYear())} className="px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-600 hover:bg-slate-100">This FY</button>
          </div>
          <div className="space-y-3">
            {fyMonths.map((m,i)=>{
              const maxM=Math.max(...fyMonths.map(x=>Math.max(x.totalMinutes,x.expectedMinutes)),TARGET_MINUTES);
              const isCurrent=m.year===today.getFullYear()&&m.month===today.getMonth();
              return (
                <div key={`${m.year}-${m.month}`} className={`rounded-2xl border p-3 ${isCurrent?"border-slate-900 bg-slate-50":"border-slate-100"}`}>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className={`text-sm font-bold ${isCurrent?"text-slate-900":"text-slate-600"}`}>{monthShort(m.year,m.month)}{isCurrent?" · now":""}</span>
                    <span className="text-xs font-mono"><span className="font-bold text-slate-900">{formatHMNoSign(m.totalMinutes)}</span><span className="text-slate-400"> / {formatHMNoSign(m.expectedMinutes)}</span></span>
                  </div>
                  <div className="relative h-2.5 rounded-full bg-slate-100 overflow-hidden">
                    <div className="absolute top-0 left-0 h-full bg-slate-200 rounded-full" style={{width:`${(m.expectedMinutes/maxM)*100}%`}}/>
                    <div className={`absolute top-0 left-0 h-full rounded-full ${m.surplus>=0?"bg-emerald-500":"bg-rose-400"}`} style={{width:`${(m.totalMinutes/maxM)*100}%`}}/>
                  </div>
                  <div className="flex items-center justify-between mt-1.5">
                    <span className="text-[11px] text-slate-500">{m.workedDays}/{m.totalWorkingDays} days · {m.leavesTaken} leaves</span>
                    <div className="flex items-center gap-3">
                      <span className={`text-[11px] font-bold ${m.surplus>=0?"text-emerald-600":"text-rose-600"}`}>{formatHM(m.surplus)}</span>
                      <span className="text-[11px] text-slate-400">Cum: <span className={`font-bold ${fyCumulative[i]>=0?"text-emerald-600":"text-rose-600"}`}>{formatHM(fyCumulative[i])}</span></span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── FY SUMMARY TAB ── */}
      {aTab==="fy"&&(
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <button onClick={()=>setFyCursor(f=>f-1)} className="p-2 rounded-lg hover:bg-slate-100 bg-white border border-slate-200"><ChevronLeft className="w-4 h-4"/></button>
              <span className="font-bold text-slate-900">Apr {fyCursor} – Mar {fyCursor+1}</span>
              <button onClick={()=>setFyCursor(f=>f+1)} className="p-2 rounded-lg hover:bg-slate-100 bg-white border border-slate-200"><ChevronRight className="w-4 h-4"/></button>
            </div>
            <button onClick={()=>setFyCursor(fyStartFor(today).getFullYear())} className="px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-600 hover:bg-slate-100 bg-white border border-slate-200">This FY</button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Tile label="Total Days" value={fyTotals.totalDays} sub="working days in FY" tone="sky"/>
            <Tile label="Days Worked" value={fyTotals.workedDays} sub={`of ${fyTotals.totalDays}`} tone="emerald"/>
            <Tile label="Leaves Taken" value={fyTotals.totalLeaves} sub="this FY" tone="amber"/>
            <Tile label="Total Hours" value={formatHMNoSign(fyTotals.totalWorked)} sub="logged this FY" tone="violet"/>
          </div>
          <div className={`rounded-3xl p-5 border ${fyTotals.surplus>=0?"border-emerald-200 bg-emerald-50":"border-rose-200 bg-rose-50"}`}>
            <p className="text-xs font-semibold text-slate-500 mb-1">FY Surplus / Deficit</p>
            <p className={`text-4xl font-bold font-mono ${fyTotals.surplus>=0?"text-emerald-700":"text-rose-700"}`}>{formatHM(fyTotals.surplus)}</p>
            <p className="text-xs text-slate-500 mt-2">vs actual days worked × 8h 30m target</p>
          </div>
          <div className="rounded-3xl bg-white border border-slate-200 p-5">
            <h3 className="font-bold text-slate-900 mb-4">Month by Month</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-xs font-bold uppercase tracking-wider text-slate-400 border-b border-slate-100"><th className="py-2 pr-3">Month</th><th className="py-2 pr-3 text-right">Worked</th><th className="py-2 pr-3 text-right">Hours</th><th className="py-2 pr-3 text-right">Surplus</th><th className="py-2 pr-0 text-right">Cumulative</th></tr></thead>
                <tbody className="divide-y divide-slate-50">
                  {fyMonths.map((m,i)=>{ const isCurrent=m.year===today.getFullYear()&&m.month===today.getMonth(); return (
                    <tr key={`${m.year}-${m.month}`} className={isCurrent?"bg-slate-50":""}>
                      <td className={`py-2.5 pr-3 font-semibold ${isCurrent?"text-slate-900":"text-slate-600"}`}>{monthShort(m.year,m.month)}</td>
                      <td className="py-2.5 pr-3 text-right text-slate-600">{m.workedDays}/{m.totalWorkingDays}</td>
                      <td className="py-2.5 pr-3 text-right font-mono font-semibold text-slate-900">{m.totalMinutes>0?formatHMNoSign(m.totalMinutes):"–"}</td>
                      <td className={`py-2.5 pr-3 text-right font-mono font-semibold ${m.surplus>=0?"text-emerald-600":"text-rose-600"}`}>{m.workedDays>0?formatHM(m.surplus):"–"}</td>
                      <td className={`py-2.5 pr-0 text-right font-mono font-bold ${fyCumulative[i]>=0?"text-emerald-600":"text-rose-600"}`}>{fyCumulative[i]!==0?formatHM(fyCumulative[i]):"–"}</td>
                    </tr>
                  );})}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}