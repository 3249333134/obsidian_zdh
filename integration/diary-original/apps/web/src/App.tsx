import {useGlassConfirm} from './GlassConfirm';
import {GlassDialog,GlassComboBox} from './GlassUI';
import {diaryPresets} from './diaryPresets';
import {GlassSelect} from './GlassSelect';
import {GlassDate} from './GlassDate';
import {FieldHint} from './FieldHint';
import {validateDiary,fieldLimit,diaryDocumentSchema,type FieldIssue} from '@diary/contracts';
import { EntityField, type EntityFieldProps } from './EntityField';
import { CompactDiaryTools } from './CompactDiaryTools';
import { DiaryPanel, DiaryInformation } from './DiaryPanel';
import { UnifiedCapture } from './Capture';
import { planClock } from './planFilters';
import { SharedTagInput } from './PlanFields';
import { useCompactBrowse } from './useCompactBrowse';
import { appendCapture, todoSchema, type CaptureDraft } from '@diary/contracts';
import { createContext, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  BookOpen, Brain, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, Clock,
  CloudOff, Feather, Lightbulb, Link2, Loader2, Moon, Plus, Save, Sparkles,
  Sun, Trash2, UserRound, MapPin, Utensils, Activity, X, Pin, PinOff, Zap, ListTodo, SlidersHorizontal,
} from "lucide-react";
import { emptyDiary, entityTypes, projectEntries, resolveRecord, type RecordRef, type TextEntry, type TextKind, type DiaryDocument, type DiaryEvent, type EntityRecord, type EntityType, type QuickFact, type TagStore, type TaggedEntity } from "@diary/contracts";
import { api, ApiError } from "./api";
import { addDays, shortDate, today, weekDates } from "./date";
import { splitSentence, type SplitDraft } from "./sentence";
import { RelationGraph } from "./RelationGraph";
import { ReceiptCollection, ReceiptNotice } from "./ReceiptCollection";
import { addedReceipts, type Receipt } from "./receipts";
import { TodoPanel } from './TodoPanel';
import { PlanNavigation, type PlanToolAction, type PlanNavigationState } from './PlanNavigation';
import { Login } from './Login';

type SaveStatus = "loading" | "saved" | "dirty" | "saving" | "offline" | "error" | "conflict";
type Conflict = { local: DiaryDocument; remote: DiaryDocument; remoteVersion: string };
const RecordContext = createContext<{ create: (ref: RecordRef) => void; open: (ref: RecordRef) => void; focus?: RecordRef }>({ create: () => {}, open: () => {} });
function RecordActions({ reference, task }: { reference: RecordRef; task?: RecordRef }) {
  const actions = useContext(RecordContext);
  return <div className="todo-entry-actions"><button className="quiet-button" onClick={() => actions.create(reference)}><Plus size={16} />创建计划</button>{task && <button className="quiet-button" onClick={() => actions.open(task)}>查看对应计划</button>}</div>;
}
function ensureEntries(d: DiaryDocument): DiaryDocument {
  if (d.entries) return d;
  const entries = { learn: [], input: [], idea: [] } as Record<TextKind, TextEntry[]>;
  for (const kind of ['learn', 'input', 'idea'] as const) entries[kind] = (kind === 'input' ? d.input.excerpt : d[kind].content).split(/\n\s*\n/).filter(Boolean).map(content => ({ id: crypto.randomUUID(), content, time: '', sources: [], tags: [], attachments: [] }));
  return projectEntries({ ...d, entries });
}

const EMPTY_TAGS: TagStore = { person: [], place: [], activity: [], food: [], thing: [] };
const TYPE_LABEL: Record<EntityType, string> = { person: "人物", place: "地点", activity: "活动", food: "食物", thing: "事物" };
const INPUT_KINDS = ["书", "文章", "影视", "播客", "课程", "其他"];

const tabs = [
  { id: "facts", label: "事实", icon: Feather },
  { id: "learn", label: "新知", icon: Lightbulb },
  { id: "input", label: "输入", icon: BookOpen },
  { id: "idea", label: "灵感", icon: Brain },
  { id: "lookup", label: "关联", icon: Link2 },
] as const;

function currentMinute(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

function newEvent(): DiaryEvent {
  return { id: crypto.randomUUID(), time: currentMinute(), note: "", remark: "", people: [], places: [], activities: [], foods: [], attachments: [] };
}

function StatusBadge({ status }: { status: SaveStatus }) {
  const map = {
    loading: ["正在读取", Sparkles], saved: ["已保存", Check], dirty: ["有未保存修改", Feather],
    saving: ["正在保存", Sparkles], offline: ["离线草稿", CloudOff], error: ["保存失败", CircleAlert], conflict: ["发现版本冲突", CircleAlert],
  } as const;
  const [label, Icon] = map[status];
  return <span className={`status status-${status}`} role="status" aria-live="polite"><Icon size={15} aria-hidden="true" />{label}</span>;
}

function AttachmentField({ attachments, onChange, date, variant = "full", limit }: { attachments: Array<{ path: string; name: string }>; onChange: (list: Array<{ path: string; name: string }>) => void; date: string; variant?: "full" | "strip"; limit?: number }) {
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const results = [];
      for (const file of Array.from(files)) {
        if (file.size > 8 * 1024 * 1024) { alert(`文件 ${file.name} 超过 8MB，已跳过`); continue; }
        try {
          results.push(await api.upload(file, date));
        } catch (e: any) { alert(`上传 ${file.name} 失败：${e.message}`); }
      }
      if (results.length) onChange([...attachments, ...results.map(r => ({ path: r.path, name: r.name }))]);
    } finally { setUploading(false); if (inputRef.current) inputRef.current.value = ""; }
  };
  const remove = (idx: number) => onChange(attachments.filter((_, i) => i !== idx));
  const displayList = limit ? attachments.slice(0, limit) : attachments;
  const overflow = limit && attachments.length > limit ? attachments.length - limit : 0;

  if (variant === "strip") {
    return <div className="attachment-strip">
      {displayList.map((att, idx) => {
        const ext = att.path.split(".").pop()?.toLowerCase() || "";
        const isImage = ["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(ext);
        return <div className="attachment-strip-item" key={att.path + idx} title={att.name} onClick={() => window.open(api.assetUrl(att.path), "_blank")}>
          {isImage ? <img src={api.assetUrl(att.path)} alt={att.name} loading="lazy" /> : <span className="attachment-strip-file">{ext.toUpperCase()}</span>}
        </div>;
      })}
      {overflow > 0 && <span className="attachment-strip-more">+{overflow}</span>}
      {uploading ? <div className="attachment-strip-uploading"><Loader2 size={14} className="spin" /></div> : (
        <label className="attachment-strip-add" title="上传附件">
          <Plus size={14} />
          <input ref={inputRef} type="file" multiple accept="image/*,.pdf,.txt" hidden onChange={(e) => void handleFiles(e.target.files)} />
        </label>
      )}
    </div>;
  }

  // full variant — always render so the "+" button is visible even with zero attachments
  return <div className="attachment-grid">
    {attachments.map((att, idx) => {
      const ext = att.path.split(".").pop()?.toLowerCase() || "";
      const isImage = ["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(ext);
      return <div className="attachment-item" key={att.path + idx}>
        {isImage
          ? <img src={api.assetUrl(att.path)} alt={att.name} loading="lazy" onClick={() => window.open(api.assetUrl(att.path), "_blank")} />
          : <a href={api.assetUrl(att.path)} target="_blank" rel="noreferrer">{att.name || ext.toUpperCase()}</a>}
        <button type="button" className="attachment-remove" onClick={() => remove(idx)} aria-label={`移除附件${att.name}`}><X size={14} /></button>
      </div>;
    })}
    {uploading && <div className="attachment-uploading"><Loader2 size={18} className="spin" />上传中...</div>}
    <label className="attachment-add" title="添加附件">
      <Plus size={18} />
      <input ref={inputRef} type="file" multiple accept="image/*,.pdf,.txt" hidden onChange={(e) => void handleFiles(e.target.files)} />
    </label>
  </div>;
}

function QuickCapture({ entities, onApply }: { entities: EntityRecord[]; onApply: (note: string, split: SplitDraft, time: string, category: string, tags: string[], location?: { name: string; lat?: number; lng?: number }) => void }) {
  const [text, setText] = useState("");
  const [draft, setDraft] = useState<SplitDraft | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisNote, setAnalysisNote] = useState("");
  const [captureTime, setCaptureTime] = useState(currentMinute);
  const [category, setCategory] = useState("facts");
  const [aiTags, setAiTags] = useState<string[]>([]);
  const [currentLocation, setCurrentLocation] = useState<{ name: string; lat?: number; lng?: number } | null>(null);
  const [quickFacts, setQuickFacts] = useState<QuickFact[]>([]);
  const requestId = useRef(0);

  const refreshQuickFacts = async () => {
    try {
      const { facts } = await api.quickFacts(30, 15);
      setQuickFacts(facts);
    } catch { /* 静默忽略 */ }
  };
  useEffect(() => { void refreshQuickFacts(); }, []);

  const applyQuickFact = async (fact: QuickFact) => {
    const split: SplitDraft = {
      people: fact.people,
      places: fact.places,
      activities: fact.activities,
      foods: fact.foods,
    };
    onApply(fact.note || fact.label, split, fact.time || currentMinute(), "facts", []);
    if (fact.source === "pinned" && fact.id) {
      try { await api.useQuickFact(fact.id); } catch { /* 忽略 */ }
      void refreshQuickFacts();
    }
  };
  const pinQuickFact = async (fact: QuickFact) => {
    if (fact.activities.length === 0) return;
    try {
      await api.pinQuickFact({
        label: fact.label,
        note: fact.note,
        time: fact.time,
        activities: fact.activities,
        places: fact.places,
        people: fact.people,
        foods: fact.foods,
      });
      void refreshQuickFacts();
    } catch { /* 忽略 */ }
  };
  const unpinQuickFact = async (id: string) => {
    try {
      await api.unpinQuickFact(id);
      void refreshQuickFacts();
    } catch { /* 忽略 */ }
  };

  // 前端直连 OpenStreetMap 逆向地理编码（绕过后端网络限制）
  const reverseGeocode = async (lat: number, lng: number): Promise<string> => {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=14&accept-language=zh-CN`;
    const resp = await fetch(url, { headers: { "Accept-Language": "zh-CN" } });
    if (!resp.ok) throw new Error("geocode failed");
    const data = await resp.json() as { address?: Record<string, string>; display_name?: string };
    const addr = data.address || {};
    return addr.suburb || addr.neighbourhood || addr.road || addr.city || addr.town || addr.village || addr.county || addr.state || data.display_name?.split(",")[0] || "";
  };

  // 打开 App 自动获取当前位置
  useEffect(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try {
        const name = await reverseGeocode(pos.coords.latitude, pos.coords.longitude);
        if (name) setCurrentLocation({ name, lat: pos.coords.latitude, lng: pos.coords.longitude });
      } catch { /* 静默失败 */ }
    }, () => { /* 用户拒绝权限或失败 */ }, { enableHighAccuracy: true, timeout: 8_000 });
  }, []);

  const refreshLocation = async () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try {
        const name = await reverseGeocode(pos.coords.latitude, pos.coords.longitude);
        if (name) setCurrentLocation({ name, lat: pos.coords.latitude, lng: pos.coords.longitude });
      } catch { /* 静默失败 */ }
    }, () => { /* 静默失败 */ }, { enableHighAccuracy: true, timeout: 8_000 });
  };
  const fillLocation = async (currentId: number) => {
    if (!navigator.geolocation) return;
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10_000 });
      });
      const name = await reverseGeocode(pos.coords.latitude, pos.coords.longitude);
      if (name && requestId.current === currentId) {
        setDraft((d) => {
          if (!d) return d;
          if (d.places.some((p) => p.name === name)) return d;
          const known = entities.find((e) => e.type === "place" && e.name === name);
          return { ...d, places: [...d.places, { type: "place", name, tags: known?.tags || [] }] };
        });
        setAnalysisNote("已用 AI 理解语境，新实体已自动建议标签。📍 已自动填入当前位置。");
      }
    } catch { /* 定位失败静默忽略，让用户手动填 */ }
  };
  const analyze = async () => {
    const sentence = text.trim();
    if (!sentence || analyzing) return;
    const id = ++requestId.current;
    setDraft(null); setAnalyzing(true); setAnalysisNote(""); setAiTags([]);
    try {
      const response = await api.splitSentence(sentence);
      if (id !== requestId.current) return;
      const { category: suggested, time, tags, ...entitiesResult } = response.result;
      setDraft(entitiesResult);
      setCategory(suggested || "facts");
      setCaptureTime(time || currentMinute());
      setAiTags(tags || []);
      setAnalysisNote("已用 AI 理解语境，新实体已自动建议标签。");
      // 如果 AI 没识别出地点，自动尝试获取当前位置
      if (entitiesResult.places.length === 0) void fillLocation(id);
    } catch {
      if (id !== requestId.current) return;
      setCategory('facts'); setCaptureTime(currentMinute());
      const localResult = splitSentence(sentence, entities);
      setDraft(localResult);
      setAnalysisNote("AI 暂时不可用，已使用本地规则拆分；你仍可修改结果。");
      if (localResult.places.length === 0) void fillLocation(id);
    } finally { if (id === requestId.current) setAnalyzing(false); }
  };
  const listField = (key: keyof SplitDraft, label: string) => {
    const items = draft?.[key] || [];
    const isPlace = key === "places";
    const manualLocate = async () => {
      if (!navigator.geolocation) return;
      try {
        const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10_000 });
        });
        const { latitude, longitude } = pos.coords;
        const resp = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=14&accept-language=zh-CN`, { headers: { "Accept-Language": "zh-CN" } });
        const data = await resp.json() as { address?: Record<string, string>; display_name?: string };
        const addr = data.address || {};
        const name = addr.suburb || addr.neighbourhood || addr.road || addr.city || data.display_name?.split(",")[0] || "";
        if (name) {
          setDraft((d) => {
            if (!d || d.places.some((p) => p.name === name)) return d;
            const known = entities.find((e) => e.type === "place" && e.name === name);
            return { ...d, places: [...d.places, { type: "place", name, tags: known?.tags || [] }] };
          });
        }
      } catch { /* 静默失败 */ }
    };
    return <label className="split-field"><span>{label}{isPlace && <button type="button" className="split-locate-btn" onClick={manualLocate} title="获取当前位置"><MapPin size={13} /> 定位</button>}</span><input value={items.map((item) => item.name).join("、")} onChange={(event) => setDraft((current) => {
      if (!current) return current;
      const type = key === "people" ? "person" : key === "places" ? "place" : key === "activities" ? "activity" : "food";
      const values = event.target.value.split(/[、,，]/).map((value) => value.trim()).filter(Boolean);
      return { ...current, [key]: values.map((name) => current[key].find((item) => item.name === name) || { type, name, tags: entities.find((item) => item.type === type && item.name === name)?.tags || [] }) };
    })} />{items.some((item) => item.tags.length) && <small className="split-tags">{items.map((item) => item.tags.length ? `${item.name}：${item.tags.join(" · ")}` : "").filter(Boolean).join("　")}</small>}</label>;
  };
  return <section className="quick-capture" aria-labelledby="quick-title">
    <div className="capture-title">
      <div><Sparkles size={20} /><h2 id="quick-title">先记下一句话</h2></div>
      {currentLocation ? (
        <button type="button" className="location-chip" onClick={refreshLocation} title="点击刷新位置"><MapPin size={13} />{currentLocation?.name}</button>
      ) : null}
      <p>这句话会发送给已配置的 AI；结果可修改。</p>
    </div>
    {quickFacts.length > 0 && (
      <div className="quick-facts" aria-label="常用事实快捷输入">
        <span className="quick-facts-label"><Activity size={14} />常用</span>
        <div className="quick-facts-track">
          {quickFacts.map((fact) => (
            <span key={`${fact.source}-${fact.id || fact.label}`} className={`fact-chip fact-chip-${fact.source}`}>
              <button type="button" className="fact-chip-main" onClick={() => void applyQuickFact(fact)} title={fact.note || fact.label}>
                {fact.source === "pinned" && <Pin size={12} className="fact-chip-pin" />}
                <span className="fact-chip-label">{fact.shortLabel || fact.label}</span>
                <span className="fact-chip-count">{fact.count}</span>
              </button>
              {fact.source === "pinned" && fact.id ? (
                <button type="button" className="fact-chip-remove" onClick={() => void unpinQuickFact(fact.id!)} aria-label="取消钉选"><PinOff size={12} /></button>
              ) : (
                <button type="button" className="fact-chip-pin-btn" onClick={() => void pinQuickFact(fact)} aria-label="钉选此事实" title="钉选后会出现在常用区，14 天不用自动消失"><Pin size={12} /></button>
              )}
            </span>
          ))}
        </div>
      </div>
    )}
    <div className="capture-row">
      <textarea value={text} onChange={(event) => { requestId.current++; setAnalyzing(false); setText(event.target.value); setDraft(null); setAnalysisNote(""); setCategory("facts"); }} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") analyze(); }} rows={2} placeholder="例如：和张三在公司讨论了新产品，晚上吃了面。" aria-label="一句话快速记录" />
      <button type="button" onClick={() => void analyze()} disabled={!text.trim() || analyzing}><Sparkles size={18} />{analyzing ? "正在理解" : "智能拆分"}</button>
    </div>
    {analysisNote && <p className="analysis-note" role="status">{analysisNote}</p>}
    {draft && <div className="split-review">
      <div className="capture-metadata"><label>时间标签<GlassDate label="记录时间" timeOnly date={planClock().date} time={captureTime} onChange={(_,time)=>setCaptureTime(time)}/></label><label>卡片类型<GlassSelect label="卡片类型" value={category} onChange={setCategory} options={tabs.slice(0,4).map(tab=>({value:tab.id,label:tab.label}))}/></label></div>
      <label className="split-field"><span>AI 推荐标签</span><input value={aiTags.join("、")} onChange={(e) => setAiTags(e.target.value.split(/[、,，]/).map(t => t.trim()).filter(Boolean))} placeholder="AI 根据内容推荐，可修改" />{aiTags.length > 0 && <small className="split-tags">{aiTags.join(" · ")}</small>}</label>
      {category === "facts" && <details className="capture-entities"><summary>查看或修改人物、地点与标签</summary><div className="split-grid">{listField("people", "人物")}{listField("places", "地点")}{listField("activities", "活动")}{listField("foods", "食物")}</div></details>}
      <div className="split-actions"><button type="button" className="quiet-button" onClick={() => setDraft(null)}>重新识别</button><button type="button" className="apply-button" onClick={() => { onApply(text.trim(), draft, captureTime, category, aiTags, currentLocation || undefined); setText(""); setDraft(null); setAnalysisNote(""); setAiTags([]); setCaptureTime(currentMinute()); }}><Check size={17} />新建{tabs.find((tab) => tab.id === category)?.label || "事实"}</button></div>
    </div>}
  </section>;
}

function FactsPanel({ document, update, common }: { document: DiaryDocument; update: (document: DiaryDocument) => void; common: Pick<EntityFieldProps, "entities" | "tags" | "onCreateTag"> }) {
  const { focus } = useContext(RecordContext);
  const events = useMemo(() => {
    const list = [...document.facts.events];
    list.sort((a, b) => {
      if (!a.time && !b.time) return 0;
      if (!a.time) return 1;
      if (!b.time) return -1;
      return a.time.localeCompare(b.time);
    });
    return list;
  }, [document.facts.events]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [optionalExpanded, setOptionalExpanded] = useState<Record<string, Set<string>>>({});
  const [locatingEventId, setLocatingEventId] = useState<string | null>(null);
  const confirmation=useGlassConfirm();
  const [quickFacts, setQuickFacts] = useState<QuickFact[]>([]);
  const [showQuickMenu, setShowQuickMenu] = useState(false);
  const [showInformation, setShowInformation] = useState(false);
  const quickMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (focus?.date === document.date && focus.kind === 'facts') setExpanded(current => new Set(current).add(focus.id)); }, [focus, document.date]);

  // 点击下拉菜单外部关闭
  useEffect(() => {
    if (!showQuickMenu) return;
    const handler = (e: MouseEvent) => {
      if (quickMenuRef.current && !quickMenuRef.current.contains(e.target as Node)) setShowQuickMenu(false);
    };
    window.document.addEventListener("mousedown", handler);
    return () => window.document.removeEventListener("mousedown", handler);
  }, [showQuickMenu]);

  const refreshQuickFacts = async () => {
    try {
      const { facts } = await api.quickFacts(30, 15);
      setQuickFacts(facts);
    } catch { /* 静默忽略 */ }
  };
  useEffect(() => { void refreshQuickFacts(); }, []);

  const addEventFromQuickFact = async (fact: QuickFact) => {
    const event: DiaryEvent = {
      ...newEvent(),
      note: fact.note || fact.label,
      activities: fact.activities,
      places: fact.places,
      people: fact.people,
      foods: fact.foods,
    };
    setExpanded((current) => new Set(current).add(event.id));
    update({ ...document, facts: { ...document.facts, events: [...events, event] } });
    setShowQuickMenu(false);
    if (fact.source === "pinned" && fact.id) {
      try { await api.useQuickFact(fact.id); } catch { /* 忽略 */ }
      void refreshQuickFacts();
    }
  };
  // 用 ref 记录每个 event 展开内容的真实高度
  const detailHeights = useRef<Record<string, number>>({});
  const heightRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [heightTick, setHeightTick] = useState(0); // 触发重渲染以更新 CSS 变量

  const measureHeights = () => {
    let changed = false;
    for (const id of Object.keys(heightRefs.current)) {
      const el = heightRefs.current[id];
      if (el) {
        const h = el.getBoundingClientRect().height + 4; // +4 过渡余量
        if (detailHeights.current[id] !== h) { detailHeights.current[id] = h; changed = true; }
      }
    }
    if (changed) setHeightTick(t => t + 1);
  };

  const updateEvent = (event: DiaryEvent) => {
    update({ ...document, facts: { ...document.facts, events: document.facts.events.map((item) => item.id === event.id ? event : item) } });
    requestAnimationFrame(measureHeights);
  };

  const reverseGeocode = async (lat: number, lng: number): Promise<string> => {
    const resp = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=14&accept-language=zh-CN`, { headers: { "Accept-Language": "zh-CN" } });
    if (!resp.ok) throw new Error("geocode failed");
    const data = await resp.json() as { address?: Record<string, string>; display_name?: string };
    const addr = data.address || {};
    return addr.suburb || addr.neighbourhood || addr.road || addr.city || addr.town || addr.village || addr.county || addr.state || data.display_name?.split(",")[0] || "";
  };

  const locateEvent = async (event: DiaryEvent) => {
    if (locatingEventId || !navigator.geolocation) return;
    setLocatingEventId(event.id);
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10_000 });
      });
      const { latitude, longitude } = pos.coords;
      const name = await reverseGeocode(latitude, longitude);
      updateEvent({ ...event, location: { name, lat: latitude, lng: longitude } });
    } catch { /* 定位失败静默忽略 */ }
    finally { setLocatingEventId(null); }
  };

  const addEvent = () => {
    const event = newEvent();
    setExpanded((current) => new Set(current).add(event.id));
    update({ ...document, facts: { ...document.facts, events: [...events, event] } });
  };
  useEffect(()=>{const add=()=>addEvent();window.document.addEventListener('diary-add-event',add);return()=>window.document.removeEventListener('diary-add-event',add);},[document]);

  const toggleEvent = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    // 展开后测量一次高度
    requestAnimationFrame(() => {
      requestAnimationFrame(measureHeights);
    });
  };

  // 每次事件列表变化都重新测量（新增/删除会影响所有高度）
  useEffect(() => {
    const t = setTimeout(measureHeights, 50);
    return () => clearTimeout(t);
  }, [events.length, heightTick]);

  const compactMeta = (event: DiaryEvent) => [event.location?.name, ...event.people, ...event.places, ...event.activities, ...event.foods].filter(Boolean).map((item) => typeof item === "string" ? item : (item as { name: string }).name).slice(0, 4).join(" · ");

  const informationSummary = [document.weather,document.sleep,document.mood,document.facts.note ? '有今日备注' : ''].filter(Boolean).join(' · ') || '天气、睡眠、心情与备注';
  return <DiaryPanel id="facts-title" title="今日事实" icon={Feather} count={events.length} className="facts-panel" informationLabel="今日信息" summary={informationSummary} onInformation={()=>setShowInformation(true)} onCreate={addEvent} actions={
        <div className="quick-facts-dropdown" ref={quickMenuRef}>
          <button type="button" aria-label="快捷事实" title="快捷事实" className={`quiet-button quick-facts-toggle ${showQuickMenu ? "active" : ""}`} onClick={() => setShowQuickMenu(s => !s)} aria-expanded={showQuickMenu}><Zap size={17} /><span>快捷</span></button>
          {showQuickMenu && (
            <div className="quick-facts-menu" role="menu">
              {quickFacts.length === 0 ? (
                <div className="quick-facts-empty">暂无快捷事实，可在事件中点「存为快捷」添加</div>
              ) : quickFacts.map((fact) => (
                <button key={`${fact.source}-${fact.id || fact.label}`} type="button" className="quick-facts-item" role="menuitem" onClick={() => void addEventFromQuickFact(fact)} title={fact.note || fact.label}>
                  <span className="quick-facts-item-prefix">{fact.source === "pinned" ? <Pin size={13} /> : <Activity size={13} />}</span>
                  <span className="quick-facts-item-label">{fact.shortLabel || fact.label}</span>
                  <span className="quick-facts-item-count">{fact.count}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      }>
    {confirmation.dialog}
    {showInformation && <DiaryInformation title="今日信息" onClose={()=>setShowInformation(false)}><div className="diary-day-information">
      {(['weather','sleep','mood'] as const).map((key,index)=><label className="field" key={key}><span>{['天气','睡眠','心情'][index]}</span><GlassComboBox label={['天气','睡眠','心情'][index]} fieldPath={key} value={document[key]} options={diaryPresets[key]} onChange={value=>update({...document,[key]:value})}/><FieldHint path={key} value={document[key]}/></label>)}
      <label className="field diary-day-note"><span>今日备注</span><textarea id="compact-day-note" data-field="facts.note" rows={4} value={document.facts.note} onChange={event=>update({...document,facts:{...document.facts,note:event.target.value}})} placeholder="补充今天的感受或背景（可选）"/><FieldHint path="facts.note" value={document.facts.note}/></label>
    </div></DiaryInformation>}
    {!events.length && <button type="button" className="diary-empty" onClick={addEvent}><Plus size={17}/>还没有事件，添加第一条记录</button>}
    {events.length > 0 && <div className="event-stack" role="region" aria-label="今日事件列表" tabIndex={0}>{events.map((event, index) => {
      const isExpanded = expanded.has(event.id);
      const detailsId = `event-details-${event.id}`;
      const cssVar = isExpanded ? { '--details-height': `${detailHeights.current[event.id] || 450}px` } as React.CSSProperties : undefined;
      return <article className="event-block" data-record-id={event.id} data-expanded={isExpanded} key={event.id} style={cssVar}>
        <header>
          <button type="button" className="event-toggle" onClick={() => toggleEvent(event.id)} aria-expanded={isExpanded} aria-controls={detailsId}>
            <span className="timeline-time"><Clock size={15} />{event.time || "未设时间"}</span>
            <span className="event-compact-copy"><strong>{event.note || `事件 ${index + 1}`}</strong>{compactMeta(event) && <small>{compactMeta(event)}</small>}</span>
            <ChevronDown className="event-chevron" aria-hidden="true" />
          </button>
          {/* 紧凑视图的附件缩略图条 */}
          <AttachmentField attachments={event.attachments || []} onChange={(list) => updateEvent({ ...event, attachments: list })} date={document.date} variant="strip" limit={3} />
          {/* 折叠/展开都可见的侧栏删除按钮 */}
          <button type="button" className="event-delete-icon" onClick={async(e) => { e.stopPropagation(); if (await confirmation.confirm(`确定删除事件 ${index + 1} 吗？事件备注也会一起删除。`)) {
            const next = document.facts.events.filter(item => item.id !== event.id);
            update({ ...document, facts: { ...document.facts, events: next } });
            delete detailHeights.current[event.id];
            delete heightRefs.current[event.id];
          } }} aria-label={`删除事件${index + 1}`}><Trash2 size={16} /></button>
        </header>
        <div className="event-details" id={detailsId}>
          {/* 内部包装层用来测量高度 */}
          <div
            className="event-details-inner"
            ref={(el) => { heightRefs.current[event.id] = el; }}
          >
            <label className="field event-time"><span>发生时间</span><GlassDate label="发生时间" timeOnly date={document.date} time={event.time} onChange={(_,time)=>updateEvent({...event,time})}/></label>
            {event.plannedStart && <p className="plan-start">原定开始（完成时快照）：{event.plannedStart.date ? `${event.plannedStart.date} ${event.plannedStart.time || '未设置时间'}` : '未设置'}</p>}
            {!!event.planEntities?.filter(entity=>entity.type==='thing').length && <p>原计划事物：{event.planEntities.filter(entity=>entity.type==='thing').map(entity=>entity.name).join('、')}</p>}
            <SharedTagInput value={event.tags || []} onChange={tags=>updateEvent({...event,tags})}/>
            <label className="field"><span>事件原句</span><textarea data-field={'facts.events.'+document.facts.events.findIndex(e=>e.id===event.id)+'.note'} rows={2} value={event.note} onChange={(e) => updateEvent({ ...event, note: e.target.value })} placeholder="用一句话描述整件事" /><FieldHint path="facts.events.0.note" value={event.note}/></label>
            <div className="field event-location">
              <span>📍定位</span>
              <div className="event-location-row">
                <input value={event.location?.name || ""} onChange={(e) => updateEvent({ ...event, location: { ...event.location, name: e.target.value } })} placeholder="点击右侧按钮获取当前位置，或手动输入" />
                <button type="button" className="square-button locate-btn" onClick={() => void locateEvent(event)} disabled={locatingEventId === event.id} aria-label="获取当前位置">
                  <MapPin size={18} className={locatingEventId === event.id ? "spinning" : ""} />
                </button>
              </div>
              {event.location?.lat != null && event.location?.lng != null && (
                <small className="event-location-coord">坐标：{event.location.lat.toFixed(5)}, {event.location.lng.toFixed(5)}</small>
              )}
            </div>
            {(() => {
              const optSet = optionalExpanded[event.id] || new Set<string>();
              const showOpt = (key: string) => optSet.has(key);
              const toggleOpt = (key: string) => setOptionalExpanded(prev => {
                const next = { ...prev };
                const s = new Set(next[event.id] || []);
                if (s.has(key)) s.delete(key); else s.add(key);
                next[event.id] = s;
                return next;
              });
              const fields = [
                { key: 'remark', label: '事件备注', hasValue: !!event.remark, render: (force: boolean) => <label className="field event-remark"><span>事件备注</span><textarea data-field={'facts.events.'+document.facts.events.findIndex(e=>e.id===event.id)+'.remark'} rows={3} value={event.remark} onChange={(e) => updateEvent({ ...event, remark: e.target.value })} placeholder="补充这件事当时的感受、背景或后续；备注会始终跟随此事件" /><FieldHint path="facts.events.0.remark" value={event.remark}/>{!event.remark && <button type="button" className="square-button opt-collapse" onClick={() => toggleOpt('remark')} aria-label="收起"><X size={16} /></button>}</label> },
                { key: 'people', label: '和谁', hasValue: event.people.length > 0, render: (force: boolean) => <EntityField label="和谁" type="person" values={event.people} onChange={(people) => updateEvent({ ...event, people })} forceShow={force} onRequestShow={() => toggleOpt('people')} {...common} /> },
                { key: 'places', label: '在哪', hasValue: event.places.length > 0, render: (force: boolean) => <EntityField label="在哪" type="place" values={event.places} onChange={(places) => updateEvent({ ...event, places })} forceShow={force} onRequestShow={() => toggleOpt('places')} {...common} /> },
                { key: 'activities', label: '做了什么', hasValue: event.activities.length > 0, render: (force: boolean) => <EntityField label="做了什么" type="activity" values={event.activities} onChange={(activities) => updateEvent({ ...event, activities })} forceShow={force} onRequestShow={() => toggleOpt('activities')} {...common} /> },
                { key: 'foods', label: '吃了什么', hasValue: event.foods.length > 0, render: (force: boolean) => <EntityField label="吃了什么" type="food" values={event.foods} onChange={(foods) => updateEvent({ ...event, foods })} forceShow={force} onRequestShow={() => toggleOpt('foods')} {...common} /> },
              ];
              const hidden = fields.filter(f => !f.hasValue && !showOpt(f.key));
              const visible = fields.filter(f => f.hasValue || showOpt(f.key));
              return <>
                {hidden.length > 0 && (
                  <div className="optional-add-row">
                    {hidden.map(f => (
                      <button key={f.key} type="button" className="optional-add-btn" onClick={() => toggleOpt(f.key)}>
                        <Plus size={14} />{f.label}
                      </button>
                    ))}
                  </div>
                )}
                <div className="entity-grid">
                  {visible.map(f => <div key={f.key} className="entity-grid-item">{f.render(showOpt(f.key))}</div>)}
                </div>
              </>;
            })()}
            {/* 附件：图片 + 文件 */}
            <div className="field"><span>附件</span><AttachmentField attachments={event.attachments || []} onChange={(list) => updateEvent({ ...event, attachments: list })} date={document.date} /></div>
            {/* 删除按钮下沉到底部 */}
            <RecordActions reference={{ date: document.date, kind: 'facts', id: event.id, summary: event.note.slice(0, 2000) }} task={event.task} />
            <div className="event-delete-row">
              {event.activities.length > 0 && (
                <button type="button" className="event-pin" onClick={() => {
                  void api.pinQuickFact({
                    label: event.note || event.activities.map(a => a.name).join("、"),
                    note: event.note,
                    time: event.time,
                    activities: event.activities as Array<{ type: "activity"; name: string; tags: string[] }>,
                    places: event.places as Array<{ type: "place"; name: string; tags: string[] }>,
                    people: event.people as Array<{ type: "person"; name: string; tags: string[] }>,
                    foods: event.foods as Array<{ type: "food"; name: string; tags: string[] }>,
                  }).then(() => { void refreshQuickFacts(); }).catch(() => { /* 忽略 */ });
                }}><Pin size={15} />存为快捷</button>
              )}
              <button type="button" className="event-delete" onClick={async() => { if (await confirmation.confirm(`确定删除事件 ${index + 1} 吗？事件备注也会一起删除。`)) {
                const next = document.facts.events.filter(item => item.id !== event.id);
                update({ ...document, facts: { ...document.facts, events: next } });
                // 清理测量缓存
                delete detailHeights.current[event.id];
                delete heightRefs.current[event.id];
              } }} aria-label={`删除事件${index + 1}`}>
                <Trash2 size={15} />删除此事件
              </button>
            </div>
          </div>
        </div>
      </article>;
    })}</div>}

  </DiaryPanel>;
}

function TextEntries({ label, kind, document, update,createRequest }: { label: string; kind: TextKind; document: DiaryDocument; update: (document: DiaryDocument) => void;createRequest:number }) {
  const entries = document.entries?.[kind] || [];
  const [newText, setNewText] = useState('');
  const newTextRef=useRef<HTMLTextAreaElement>(null);
  const [composing,setComposing]=useState(false);
  const focusRequested=useRef(false);
  const focusComposer=()=>{focusRequested.current=true;setComposing(true);if(newTextRef.current){newTextRef.current.scrollIntoView({block:'nearest'});newTextRef.current.focus();focusRequested.current=false;}};
  useEffect(()=>{if(composing&&focusRequested.current&&newTextRef.current){newTextRef.current.scrollIntoView({block:'nearest'});newTextRef.current.focus();focusRequested.current=false;}},[composing,createRequest]);
  useEffect(()=>{if(createRequest)focusComposer();},[createRequest]);
  const confirmation=useGlassConfirm();
  const [tagging, setTagging] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const heightRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const detailHeights = useRef<Record<string, number>>({});
  const toggle = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  // 测量展开内容高度，用于 CSS transition
  useEffect(() => {
    for (const id of expanded) {
      const el = heightRefs.current[id];
      if (el) detailHeights.current[id] = el.scrollHeight;
    }
  }, [expanded, entries]);
  const change = (values: TextEntry[]) => update(projectEntries({ ...document, entries: { ...ensureEntries(document).entries!, [kind]: values } }));
  const aiTag = async (entry: TextEntry) => {
    if (!entry.content.trim()) return;
    setTagging(entry.id);
    try {
      const suggested = await api.suggestTags(entry.content, kind);
      if (suggested.length) {
        const merged = [...new Set([...entry.tags, ...suggested])];
        change(entries.map(item => item.id === entry.id ? { ...item, tags: merged } : item));
      }
    } catch { /* 忽略 AI 失败 */ }
    finally { setTagging(null); }
  };
  const compactMeta = (entry: TextEntry) => {
    const parts: string[] = [];
    if (entry.tags.length) parts.push(entry.tags.join(' · '));
    if (kind !== 'idea' && entry.sources.length) parts.push('来源：' + entry.sources.map(s => s.name).join('、'));
    return parts.join('　');
  };
  const iconForKind = kind === 'learn' ? Lightbulb : kind === 'input' ? BookOpen : Brain;
  const KindIcon = iconForKind;
  return <div className="diary-entries">{confirmation.dialog}
    {entries.length === 0
      ? <button type="button" className="diary-empty" onClick={focusComposer}><KindIcon size={18}/><span>还没有{label}记录，先写一句。</span></button>
      : <div className="event-stack">
          {entries.map((entry, index) => {
            const isExpanded = expanded.has(entry.id);
            const detailsId = `entry-details-${entry.id}`;
            const cssVar = isExpanded ? { '--details-height': `${detailHeights.current[entry.id] || 300}px` } as React.CSSProperties : undefined;
            const preview = entry.content.split(/\n/)[0] || `${label} ${index + 1}`;
            return <article className="event-block" data-record-id={entry.id} data-expanded={isExpanded} key={entry.id} style={cssVar}>
              <header>
                <button type="button" className="event-toggle" onClick={() => toggle(entry.id)} aria-expanded={isExpanded} aria-controls={detailsId}>
                  <span className="timeline-time"><Clock size={15} />{entry.time || "未设时间"}</span>
                  <span className="event-compact-copy"><strong>{preview}</strong>{compactMeta(entry) && <small>{compactMeta(entry)}</small>}</span>
                  <ChevronDown className="event-chevron" aria-hidden="true" />
                </button>
                {/* 紧凑视图的附件缩略图条 */}
                <AttachmentField attachments={entry.attachments || []} onChange={(list) => change(entries.map(item => item.id === entry.id ? { ...item, attachments: list } : item))} date={document.date} variant="strip" limit={3} />
                <button type="button" className="event-delete-icon" onClick={async(e) => { e.stopPropagation(); if (await confirmation.confirm(`删除此${label}？相关待办保留。`)) { change(entries.filter(e => e.id !== entry.id)); delete detailHeights.current[entry.id]; delete heightRefs.current[entry.id]; } }} aria-label={`删除${label}${index + 1}`}><Trash2 size={16} /></button>
              </header>
              <div className="event-details" id={detailsId}>
                <div className="event-details-inner" ref={(el) => { heightRefs.current[entry.id] = el; }}>
                  <label className="field event-time"><span>记录时间</span><GlassDate label="记录时间" timeOnly date={document.date} time={entry.time} onChange={(_,time)=>change(entries.map(item=>item.id===entry.id?{...item,time}:item))}/></label>
                  <label className="field"><span>{label}内容</span><textarea data-field={'entries.'+kind+'.'+index+'.content'} rows={4} value={entry.content} onChange={e => change(entries.map(item => item.id === entry.id ? { ...item, content: e.target.value } : item))} /><FieldHint path="entries.input.0.content" value={entry.content}/></label>
                  <div className="field">
                    <span>标签</span>
                    <div className="ai-tag-row">
                      <input value={entry.tags.join('、')} onChange={e => change(entries.map(item => item.id === entry.id ? { ...item, tags: e.target.value.split('、').filter(Boolean) } : item))} placeholder="AI 推荐或手动输入，顿号分隔" />
                      <button type="button" className="square-button ai-tag-btn" disabled={tagging === entry.id || !entry.content.trim()} onClick={() => void aiTag(entry)} title="AI 根据内容推荐标签">
                        {tagging === entry.id ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />}
                      </button>
                    </div>
                  </div>
                  {kind !== 'idea' && <label className="field"><span>来源（顿号分隔）</span><input value={entry.sources.map(s => s.name).join('、')} onChange={e => { const names = e.target.value.split('、'); change(entries.map(item => item.id === entry.id ? { ...item, sources: names.filter(Boolean).map(name => ({ type: 'thing' as const, name, tags: [] })) } : item)); }} /></label>}
                  <div className="field"><span>附件</span><AttachmentField attachments={entry.attachments || []} onChange={(list) => change(entries.map(item => item.id === entry.id ? { ...item, attachments: list } : item))} date={document.date} /></div>
                  <RecordActions task={entry.task} reference={{ date: document.date, kind, id: entry.id, summary: entry.content.slice(0, 2000) }} />
                </div>
              </div>
            </article>;
          })}
        </div>}
    {(composing||!entries.length||newText.length>0)&&<form className="diary-entry-composer" onSubmit={e => { e.preventDefault(); if (!newText.trim() || newText.length>(fieldLimit(diaryDocumentSchema,'entries.input.0.content')||50000)) return; const entry: TextEntry = { id: crypto.randomUUID(), content: newText.trim(), time: currentMinute(), sources: [], tags: [], attachments: [] }; change([...entries, entry]); setExpanded(prev => new Set([...prev, entry.id])); setNewText('');setComposing(false); }}>
      <label className="field"><span>新建一条{label}</span><textarea ref={newTextRef} rows={3} value={newText} onChange={e => setNewText(e.target.value)} placeholder={`写一条${label.toLowerCase()}...`} /></label>
      <FieldHint path="entries.input.0.content" value={newText}/><button className="quiet-button" disabled={!newText.trim()||newText.length>(fieldLimit(diaryDocumentSchema,'entries.input.0.content')||50000)}><Plus size={17} />新建{label}</button>
    </form>}
  </div>;
}

function TextPanel({ kind, document, update, common }: { kind: "learn" | "input"; document: DiaryDocument; update: (document: DiaryDocument) => void; common: Pick<EntityFieldProps, "entities" | "tags" | "onCreateTag"> }) {
  const [information,setInformation]=useState(false),[createRequest,setCreateRequest]=useState(0);
  const learn=kind==='learn',label=learn?'新知':'输入';
  const summary=learn?(document.learn.sources.map(s=>s.name).join('、')||'添加来源'):[document.input.kind,document.input.names.map(s=>s.name).join('、')||'添加名称'].filter(Boolean).join(' · ');
  return <DiaryPanel id={`${kind}-title`} title={learn?'今日新知':'输入记录'} icon={learn?Lightbulb:BookOpen} count={document.entries?.[kind].length||0} summary={summary} informationLabel={learn?'来源':'输入信息'} onInformation={()=>setInformation(true)} onCreate={()=>setCreateRequest(n=>n+1)}>
    {information&&<DiaryInformation title={learn?'新知来源':'输入信息'} onClose={()=>setInformation(false)}>
      {learn?<EntityField label="来源" type="thing" values={document.learn.sources} onChange={sources=>update({...document,learn:{...document.learn,sources}})} {...common}/>:<>
        <label className="field"><span>类型</span><GlassSelect label="类型" value={document.input.kind} onChange={kind=>update({...document,input:{...document.input,kind}})} options={INPUT_KINDS.map(value=>({value,label:value}))}/></label>
        <EntityField label="名称" type="thing" values={document.input.names} onChange={names=>update({...document,input:{...document.input,names}})} {...common}/>
      </>}
    </DiaryInformation>}
    <TextEntries label={label} kind={kind} document={document} update={update} createRequest={createRequest}/>
  </DiaryPanel>;
}

function IdeaPanel({ document, update, tags, onCreateTag }: { document: DiaryDocument; update: (document: DiaryDocument) => void; tags: TagStore; onCreateTag: (type: EntityType, tag: string) => Promise<void> }) {
  const [input, setInput] = useState("");
  const [information,setInformation]=useState(false),[createRequest,setCreateRequest]=useState(0);
  const options = [...new Set(Object.values(tags).flat())].filter((tag) => !document.idea.tags.includes(tag)).slice(0, 16);
  const add = async () => { const value = input.trim(); if (!value) return; update({ ...document, idea: { ...document.idea, tags: [...new Set([...document.idea.tags, value])] } }); await onCreateTag("thing", value); setInput(""); };
  return <DiaryPanel id="idea-title" title="灵感碎片" icon={Brain} count={document.entries?.idea.length||0} summary={document.idea.tags.join(' · ')||'选择或新建标签'} informationLabel="标签" onInformation={()=>setInformation(true)} onCreate={()=>setCreateRequest(n=>n+1)}>
    {information&&<DiaryInformation title="灵感标签" onClose={()=>setInformation(false)}>
    <div className="field"><span>标签</span><div className="idea-tags">{document.idea.tags.map((tag) => <span key={tag}>{tag}<button type="button" onClick={() => update({ ...document, idea: { ...document.idea, tags: document.idea.tags.filter((item) => item !== tag) } })} aria-label={`移除标签${tag}`}><X size={13} /></button></span>)}</div>
      <div className="tag-options suggestions">{options.map((tag) => <button type="button" key={tag} onClick={() => update({ ...document, idea: { ...document.idea, tags: [...document.idea.tags, tag] } })}>{tag}</button>)}</div>
      <div className="entity-entry"><input value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void add(); } }} placeholder="输入新标签" /><button type="button" className="square-button" onClick={() => void add()} aria-label="添加标签"><Plus size={18} /></button></div>
    </div>
    </DiaryInformation>}
    <TextEntries label="灵感" kind="idea" document={document} update={update} createRequest={createRequest}/>
  </DiaryPanel>;
}

function LookupPanel({ entities, selected, onSelect, onOpenDate }: { entities: EntityRecord[]; selected: EntityRecord | null; onSelect: (entity: EntityRecord) => void; onOpenDate: (date: string) => void }) {
  const { open } = useContext(RecordContext);
  return <RelationGraph entities={entities} selected={selected} onSelect={onSelect} onOpenDate={onOpenDate} onOpenRecord={open} />;
}

function ConflictBanner({ conflict, onRemote, onLocal }: { conflict: Conflict; onRemote: () => void; onLocal: () => void }) {
  const [showDiff, setShowDiff] = useState(false);
  return <div className="conflict-banner" role="alert"><CircleAlert /><div><strong>云端内容已经变化</strong><p>自动保存已暂停。你可以先比较两个版本，再决定保留哪一份。</p><div><button type="button" onClick={() => void navigator.clipboard.writeText(JSON.stringify(conflict.local, null, 2))}>复制本地草稿</button><button type="button" onClick={() => setShowDiff((value) => !value)}>{showDiff ? "收起对比" : "查看差异"}</button><button type="button" onClick={onRemote}>加载云端版本</button><button type="button" className="danger-choice" onClick={onLocal}>以本地草稿继续</button></div>{showDiff && <div className="conflict-compare"><section><h3>本地草稿</h3><pre>{JSON.stringify(conflict.local, null, 2)}</pre></section><section><h3>云端版本</h3><pre>{JSON.stringify(conflict.remote, null, 2)}</pre></section></div>}</div></div>;
}

export function App() {
  const initialDate = today();
  const [date, setDate] = useState(initialDate);
  const [diary, setDiary] = useState<DiaryDocument>(() => emptyDiary(initialDate));
  const [version, setVersion] = useState("0");
  const [status, setStatus] = useState<SaveStatus>("loading");
  const [saveError,setSaveError]=useState('');
  const [serverIssues,setServerIssues]=useState<FieldIssue[]>([]);
  const [refreshWarning,setRefreshWarning]=useState('');
  const [reauth,setReauth]=useState(false);
  const activeDate=useRef(date);activeDate.current=date;
  const localIssues=useMemo(()=>validateDiary(diary),[diary]);
  const issues=localIssues.length?localIssues:serverIssues;
  const focusIssue=(issue?:FieldIssue)=>{
    if(!issue)return;
    setShowReceipts(false);setShowTodos(false);
    const tab=issue.path.startsWith('learn')||issue.path.startsWith('entries.learn')?1:issue.path.startsWith('input')||issue.path.startsWith('entries.input')?2:issue.path.startsWith('idea')||issue.path.startsWith('entries.idea')?3:0;
    selectTab(tab);
    requestAnimationFrame(()=>{
      let el=window.document.querySelector<HTMLElement>('[data-field="'+CSS.escape(issue.path)+'"]');
      const metadata=issue.path==='facts.note'||['weather','sleep','mood'].includes(issue.path)||/^(learn\.sources|input\.(kind|names)|idea\.tags)/.test(issue.path);
      if(metadata&&!el)window.document.querySelector<HTMLButtonElement>('#panel-'+tabs[tab].id+' .diary-information')?.click();
      const toggle=el?.closest('article')?.querySelector<HTMLButtonElement>('[aria-expanded=false]');
      toggle?.click();
      requestAnimationFrame(()=>{el=window.document.querySelector<HTMLElement>('[data-field="'+CSS.escape(issue.path)+'"]')||window.document.querySelector<HTMLElement>('#panel-'+tabs[tab].id+' textarea')||window.document.querySelector('#compact-day-note');el?.scrollIntoView({block:'center'});el?.focus();});
    });
  };
  const [activeTab, setActiveTab] = useState(0);
  // ── 登录态 ──
  const [authState, setAuthState] = useState<{ checking: boolean; user: { id: number; username: string } | null }>({ checking: true, user: null });
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const me = await api.auth.me();
        if (!cancelled) setAuthState({ checking: false, user: me });
      } catch {
        if (!cancelled) setAuthState({ checking: false, user: null });
      }
    })();
    return () => { cancelled = true; };
  }, []);
  useEffect(()=>{const expired=()=>{if(authState.user)setReauth(true);};window.addEventListener('diary-auth-required',expired);return()=>window.removeEventListener('diary-auth-required',expired);},[authState.user]);
  const handleLogout = async () => {
    try { await api.auth.logout(); } catch { /* ignore */ }
    setAuthState({ checking: false, user: null });
  };
  useEffect(() => {
    const viewport = window.visualViewport;
    const update = () => { window.document.documentElement.style.setProperty('--app-height', `${viewport?.height || window.innerHeight}px`); };
    update(); viewport?.addEventListener('resize', update); window.addEventListener('resize', update);
    return () => { viewport?.removeEventListener('resize', update); window.removeEventListener('resize', update); window.document.documentElement.style.removeProperty('--app-height'); };
  }, []);
  const [mobileLayout,setMobileLayout]=useState(()=>window.matchMedia('(max-width:899px)').matches);
  useEffect(()=>{const media=window.matchMedia('(max-width:899px)'),update=()=>setMobileLayout(media.matches);media.addEventListener('change',update);return()=>media.removeEventListener('change',update);},[]);
  const [showReceipts, setShowReceipts] = useState(false);
  const [showTodos, setShowTodos] = useState(false);
  const browseRef = useRef<HTMLElement>(null);
  const [diaryTools, setDiaryTools] = useState(false);
  const [planToolbarAction, setPlanToolbarAction] = useState<PlanToolAction>();
  const [planNavigation,setPlanNavigation]=useState<PlanNavigationState>();
  const requestPlanTool = (kind:PlanToolAction['kind'],value?:string) => setPlanToolbarAction({kind,value,id:Date.now()});
  const compactBrowse = useCompactBrowse(browseRef, !showReceipts && (showTodos || activeTab !== 4), `${showTodos ? 'plan' : activeTab}:${date}`);
  const [fullscreen, setFullscreen] = useState(false);
  // 全屏时触发全局紧凑导航，退出时恢复
  useEffect(() => {
    if (fullscreen) compactBrowse.collapse();
    else compactBrowse.expand();
  }, [fullscreen, compactBrowse]);
  const [actionsRevision, setActionsRevision] = useState(0);
  const [actionSource, setActionSource] = useState<RecordRef>();
  const [focusRecord, setFocusRecord] = useState<RecordRef>();
  const [actionError, setActionError] = useState('');
  const [printedReceipts, setPrintedReceipts] = useState<Receipt[]>([]);
  const [entities, setEntities] = useState<EntityRecord[]>([]);
  const [tags, setTags] = useState<TagStore>(EMPTY_TAGS);
  const [selectedEntity, setSelectedEntity] = useState<EntityRecord | null>(null);
  const [week, setWeek] = useState<{ start: string; end: string; entries: Array<{ date: string; document: DiaryDocument }> } | null>(null);
  const [summaryMessage, setSummaryMessage] = useState("");
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const conflictRef = useRef<Conflict | null>(null);
  const [theme, setTheme] = useState(() => localStorage.getItem("diary.theme") || "light");
  const hydrated = useRef(false);
  const lastSaved = useRef("");
  const diaryRef = useRef(diary);
  const versionRef = useRef(version);
  const saving = useRef(false);
  const pending = useRef(false);
  const trackRef = useRef<HTMLDivElement>(null);

  diaryRef.current = diary;
  versionRef.current = version;

  const refreshContext = async (currentDate = date) => {
    const [entityData, tagData, weekData] = await Promise.all([api.entities(), api.tags(), api.week(currentDate)]);
    if(activeDate.current!==currentDate)return;
    setEntities(entityData.entities); setTags(tagData.tags); setWeek(weekData);
    if (selectedEntity) setSelectedEntity(entityData.entities.find((item) => item.key === selectedEntity.key) || null);
  };

  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem("diary.theme", theme); }, [theme]);

  useEffect(() => {
    let cancelled = false;
    if(!authState.user){hydrated.current=false;return;}
    hydrated.current = false; setSaveError(""); setServerIssues([]); setRefreshWarning(""); setStatus("loading"); conflictRef.current = null; setConflict(null); setSelectedEntity(null);
    void (async () => {
      try {
        const remote = await api.loadDiary(date);
        remote.document = ensureEntries(remote.document);
        if (cancelled) return;
        const key = `diary.draft.${date}`;
        const stored = localStorage.getItem(key);
        const draft = stored ? JSON.parse(stored) as { document: DiaryDocument; baseVersion: string } : null;
        if (draft) { draft.document = ensureEntries(draft.document); draft.document.todos ||= []; draft.document.todosExtra ||= ''; draft.document.facts.events = draft.document.facts.events.map((event) => ({ ...event, time: event.time || "", remark: event.remark || "" })); }
        lastSaved.current = JSON.stringify(remote.document); setVersion(remote.version); versionRef.current = remote.version;
        if (draft && draft.baseVersion === remote.version && JSON.stringify(draft.document) !== lastSaved.current) { setDiary(draft.document); setStatus("dirty"); }
        else if (draft && draft.baseVersion !== remote.version) { const nextConflict = { local: draft.document, remote: remote.document, remoteVersion: remote.version }; setDiary(remote.document); conflictRef.current = nextConflict; setConflict(nextConflict); setStatus("conflict"); }
        else { setDiary(remote.document); setStatus("saved"); }
        hydrated.current = true;
        await refreshContext(date).catch(()=>{if(!cancelled)setRefreshWarning("日记已读取，关联信息刷新失败");});
      } catch { if (!cancelled) setStatus(navigator.onLine ? "error" : "offline"); }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date,authState.user?.id]);

  async function saveNow(snapshot = diaryRef.current, explicit=false) {
    if (!hydrated.current || conflictRef.current || snapshot.date!==activeDate.current) return;
    const problems=validateDiary(snapshot);
    if(problems.length){setServerIssues([]);setSaveError('请修改标出的字段，草稿已保留');setStatus('error');if(explicit)focusIssue(problems[0]);return;}
    if(JSON.stringify(snapshot)===lastSaved.current){if(explicit&&refreshWarning)void refreshContext(snapshot.date).then(()=>setRefreshWarning('')).catch(()=>{});return;}
    if (saving.current) { pending.current = true; return; }
    const target=snapshot.date,expected=versionRef.current,serialized=JSON.stringify(snapshot);
    const previous=lastSaved.current;
    saving.current = true; setSaveError('');setServerIssues([]);setStatus("saving");
    try {
      const result = await api.saveDiary(target, snapshot, expected);
      const key='diary.draft.'+target;
      const stored=localStorage.getItem(key);
      try{if(stored){const draft=JSON.parse(stored);if(JSON.stringify(draft.document)===serialized)localStorage.removeItem(key);else localStorage.setItem(key,JSON.stringify({...draft,baseVersion:result.version}));}}catch{ /* Cloud write succeeded; local metadata must not turn it into a save failure. */ }
      if(activeDate.current!==target)return;
      const printed = addedReceipts(previous ? JSON.parse(previous) as DiaryDocument : emptyDiary(target), snapshot);
      if (printed.length) setPrintedReceipts(printed);
      versionRef.current = result.version; setVersion(result.version); lastSaved.current = serialized;
      if (JSON.stringify(diaryRef.current) === serialized) setStatus("saved"); else { setStatus("dirty"); pending.current = true; }
      setRefreshWarning(result.warning?.message||'');
      await refreshContext(target).catch(()=>{if(activeDate.current===target)setRefreshWarning('日记已保存，关联信息刷新失败，可重试');});
    } catch (error) {
      if(activeDate.current!==target)return;
      const problem = error as ApiError;
      if (problem.status === 409 && problem.data?.current) { const nextConflict = { local: diaryRef.current, remote: problem.data.current.document, remoteVersion: problem.data.current.version }; conflictRef.current = nextConflict; setConflict(nextConflict); setStatus("conflict"); }
      else {setServerIssues(problem.data?.issues||[]);setSaveError(problem.message+(problem.data?.requestId?'（请求 '+problem.data.requestId+'）':''));setStatus(navigator.onLine ? "error" : "offline");}
    } finally {
      saving.current = false;
      if (pending.current && !conflictRef.current) { pending.current = false; window.setTimeout(() => void saveNow(diaryRef.current), 50); }
    }
  }

  useEffect(() => {
    if (!hydrated.current) return;
    setServerIssues([]);setSaveError("");
    const serialized = JSON.stringify(diary);
    if (serialized === lastSaved.current) return;
    localStorage.setItem(`diary.draft.${date}`, JSON.stringify({ document: diary, baseVersion: versionRef.current }));
    if (!conflict) setStatus(navigator.onLine ? "dirty" : "offline");
    const timer = window.setTimeout(() => void saveNow(diary), 1500);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diary, date, conflict]);

  useEffect(() => {
    const online = () => { if (status === "offline") void saveNow(); };
    const offline = () => setStatus("offline");
    window.addEventListener("online", online); window.addEventListener("offline", offline);
    return () => { window.removeEventListener("online", online); window.removeEventListener("offline", offline); };
  });

  const common = { entities, tags, onCreateTag: async (type: EntityType, name: string) => { const result = await api.addTag(type, name); setTags(result.tags); } };
  const currentWeekDates = weekDates(date);
  const recordedDates = new Set(week?.entries.map((entry) => entry.date) || []);
  const todayLabel = date === initialDate ? "今天" : shortDate(date);

  const updateDiary = (next: DiaryDocument) => { next = projectEntries(ensureEntries(next)); diaryRef.current = next; setDiary(next); };
  const prepareAction = async (targetDate?: string): Promise<string | undefined> => {
    if (targetDate && targetDate !== diaryRef.current.date) return undefined;
    const wasDirty = JSON.stringify(diaryRef.current) !== lastSaved.current;
    await saveNow();
    if (!hydrated.current || saving.current || conflictRef.current || JSON.stringify(diaryRef.current) !== lastSaved.current) throw new Error('请先完成当前草稿保存或处理版本冲突，再操作计划。');
    return wasDirty ? versionRef.current : undefined;
  };
  const reloadAfterAction = async () => {
    setActionsRevision(n => n + 1);
    if (conflictRef.current || JSON.stringify(diaryRef.current) !== lastSaved.current) { await refreshContext(date); return; }
    const expected = lastSaved.current;
    const saved = await api.loadDiary(date); saved.document = ensureEntries(saved.document);
    if (JSON.stringify(diaryRef.current) !== expected || diaryRef.current.date !== date) return;
    lastSaved.current = JSON.stringify(saved.document); versionRef.current = saved.version; setVersion(saved.version); updateDiary(saved.document); setStatus('saved');
    localStorage.removeItem(`diary.draft.${date}`); await refreshContext(date);
  };
  const createFromRecord = async (ref: RecordRef) => {
    try { await prepareAction(); setActionSource(ref); setShowTodos(true); setShowReceipts(false); setActionError(''); }
    catch (e) { setActionError(e instanceof Error ? e.message : '请先保存'); }
  };
  const openRecord = async (ref: RecordRef) => {
    try { await prepareAction(); const owner = await api.loadDiary(ref.date);
      if (resolveRecord(owner.document, ref) === undefined) { setActionError(`原记录已删除：${ref.summary}`); return; }
      if (ref.kind !== 'todo') setDate(ref.date); setFocusRecord(ref); setActionSource(undefined); setShowTodos(ref.kind === 'todo'); setShowReceipts(false); setActionError('');
      if (ref.kind !== 'todo') selectTab(Math.max(0, tabs.findIndex(tab => tab.id === ref.kind)));
    } catch (e) { setActionError(e instanceof Error ? e.message : '无法打开记录'); }
  };
  useEffect(() => {
    if (!focusRecord || (focusRecord.kind !== 'todo' && diary.date !== focusRecord.date) || status === 'loading') return;
    const timer = window.setTimeout(() => {
      const node = document.querySelector<HTMLElement>(`[data-record-id="${focusRecord.id}"]`);
      node?.scrollIntoView({ block: 'center', behavior: 'auto' }); if (node) { node.tabIndex = -1; node.focus({ preventScroll: true }); }
    }, 150);
    return () => clearTimeout(timer);
  }, [focusRecord, diary.date, status, showTodos, actionsRevision]);
  const captureOwners = useRef(new Map<string, string>());
  const saveCapture = async (draft: CaptureDraft): Promise<RecordRef> => {
    const targetDate = captureOwners.current.get(draft.id) || (draft.kind === 'plan' ? planClock().date : draft.date);
    captureOwners.current.set(draft.id, targetDate);
    if (!targetDate) throw new Error('请选择日记日期');
    await prepareAction(targetDate);
    const target = await api.loadDiary(targetDate);
    if (draft.kind === 'plan') {
      const task = todoSchema.parse({ id: draft.id, repeat:draft.repeat, title: draft.content, description: draft.description, category: draft.category, important: draft.important, urgent: draft.urgent, startDate: draft.startDate, startTime: draft.startTime, dueDate: draft.date, dueTime: draft.time, priority: draft.priority, list: draft.list, tags: draft.tags, entities: Object.values(draft.entities).flat() });
      await api.changeAction({mode:'create',date:targetDate,version:target.version,task,operationId:draft.id});
    } else {
      const document = appendCapture(target.document, draft);
      await api.saveDiary(targetDate, document, target.version);
    }
    await reloadAfterAction();
    return {date:targetDate,kind:draft.kind === 'plan' ? 'todo' : draft.kind,id:draft.id,summary:draft.content.slice(0,2000)};
  };
  const applyCapture = (note: string, split: SplitDraft, time: string, category: string, tags: string[], location?: { name: string; lat?: number; lng?: number }) => {
    if (category === 'learn' || category === 'input' || category === 'idea') {
      const current = ensureEntries(diaryRef.current); const entries = current.entries!;
      updateDiary({ ...current, entries: { ...entries, [category]: [...entries[category], { id: crypto.randomUUID(), content: note, time, sources: [], tags, attachments: [] }] } });
    }
    else {
      const event: DiaryEvent = { id: crypto.randomUUID(), time, note, remark: "", location: location?.name || location?.lat != null ? location : undefined, ...split, attachments: [] };
      updateDiary({ ...diary, facts: { ...diary.facts, events: [...diary.facts.events, event] } });
    }
    selectTab(Math.max(0, tabs.findIndex((tab) => tab.id === category)));
  };
  const selectTab = (index: number) => {
    setActiveTab(index);
    requestAnimationFrame(() => {
      const track = trackRef.current;
      if (track && window.matchMedia('(max-width: 899px)').matches) track.scrollTo({ left: index === 4 ? 0 : index * track.clientWidth, behavior: 'auto' });
    });
  };
  const onTrackScroll = () => {
    if (activeTab === 4) return;
    const track = trackRef.current;
    if (!track || !window.matchMedia("(max-width: 899px)").matches) return;
    const trackLeft = track.getBoundingClientRect().left;
    const panels = Array.from(track.children) as HTMLElement[];
    const nearest = panels.reduce((best, item, index) => {
      const distance = Math.abs(item.getBoundingClientRect().left - trackLeft);
      return distance < best.distance ? { index, distance } : best;
    }, { index: 0, distance: Number.POSITIVE_INFINITY });
    setActiveTab(nearest.index);
  };

  const panel = (index: number) => {
    if (index === 0) return <FactsPanel document={diary} update={updateDiary} common={common} />;
    if (index === 1) return <TextPanel kind="learn" document={diary} update={updateDiary} common={common} />;
    if (index === 2) return <TextPanel kind="input" document={diary} update={updateDiary} common={common} />;
    if (index === 3) return <IdeaPanel document={diary} update={updateDiary} tags={tags} onCreateTag={common.onCreateTag} />;
    return <LookupPanel entities={entities} selected={selectedEntity} onSelect={setSelectedEntity} onOpenDate={(next) => { setDate(next); selectTab(0); }} />;
  };
  const diaryNavigation=<nav className="section-nav" role="tablist" aria-label="日记栏目">{tabs.map((tab,index)=>{const Icon=tab.icon;return <button type="button" key={tab.id} role="tab" aria-selected={activeTab===index} aria-controls={`panel-${tab.id}`} className={activeTab===index?'active':''} onClick={()=>selectTab(index)}><Icon/><span>{tab.label}</span></button>;})}</nav>;

  if (authState.checking) {
    return <div className="login-page"><div className="login-card" style={{textAlign:'center'}}>加载中...</div></div>;
  }
  if (!authState.user) {
    return <Login onAuth={async () => { try { const me = await api.auth.me(); setAuthState({ checking: false, user: me }); } catch { setAuthState({ checking: false, user: null }); } }} />;
  }

  return <RecordContext.Provider value={{ create: ref => void createFromRecord(ref), open: ref => void openRecord(ref), focus: focusRecord }}><div className="app-shell">
    <a className="skip-link" href="#main-content">跳到日记内容</a>
    <aside className="date-rail" aria-label="日期导航">
      <div className="brand"><span><Feather /></span><div><strong>独立日记</strong><small>云端存储</small></div></div>
      <nav className="workspace-switch" aria-label="主要功能"><button aria-pressed={!showTodos} onClick={() => setShowTodos(false)}>日记</button><button aria-pressed={showTodos} onClick={() => setShowTodos(true)}>计划</button></nav><div hidden={showTodos}><div className="rail-today"><CalendarDays /><div><strong>{todayLabel}</strong><span>{date}</span></div></div>
      <div className="week-list">{currentWeekDates.map((item) => <button type="button" key={item} className={item === date ? "active" : ""} onClick={() => setDate(item)}><span>{shortDate(item)}</span>{recordedDates.has(item) && <i aria-label="已有日记" />}</button>)}</div>
      <button type="button" className="today-button" onClick={() => setDate(initialDate)}>回到今天</button>
      </div>{showTodos&&<PlanNavigation state={planNavigation} onAction={requestPlanTool}/>}<div className="rail-note"><strong>{authState.user?.username}</strong><span>已登录云端</span></div>
    </aside>

    <main ref={browseRef} id="main-content" className="main-content" data-compact={compactBrowse.compact} data-workspace={showTodos ? 'plan' : showReceipts ? 'receipts' : tabs[activeTab].id}>
      <nav className="compact-browse-bar" aria-label="紧凑浏览工具栏">
        <button aria-label="日记" aria-pressed={!showTodos} title="日记" onClick={()=>setShowTodos(false)}><Feather size={20}/><small>日记</small></button>
        <button aria-label="计划" aria-pressed={showTodos} title="计划" onClick={()=>setShowTodos(true)}><ListTodo size={20}/><small>计划</small></button>
        <button className="compact-browse-context" aria-label={showTodos?'筛选计划':'日期与今日信息'} aria-haspopup="dialog" onClick={()=>showTodos?requestPlanTool('filters'):setDiaryTools(true)}>{showTodos?<SlidersHorizontal size={18}/>:<CalendarDays size={18}/>}<span>{showTodos?'筛选':date.slice(5).replace('-','/')}</span><ChevronDown size={14}/></button>
        <button aria-label={theme==='light'?'切换到深色主题':'切换到浅色主题'} onClick={()=>setTheme(theme==='light'?'dark':'light')}>{theme==='light'?<Moon size={20}/>:<Sun size={20}/>}</button>
        {!showTodos&&<button className={status==='dirty'?'has-unsaved-change':''} aria-label="保存日记" disabled={status==='saving'||status==='loading'||status==='conflict'} onClick={()=>void saveNow(diaryRef.current,true)}><Save size={20}/></button>}
        {showTodos&&<button aria-label="新增计划" onClick={()=>requestPlanTool('create')}><Plus size={20}/></button>}
        <button aria-label={`退出登录 ${authState.user?.username || ''}`} title={`退出登录 (${authState.user?.username})`} onClick={()=>void handleLogout()}><UserRound size={20}/></button>
      </nav>
      {diaryTools && <CompactDiaryTools date={date} onDate={setDate} diary={diary} update={updateDiary} onClose={()=>setDiaryTools(false)} onExpand={()=>{setDiaryTools(false);compactBrowse.expand();}} onReceipts={()=>{setDiaryTools(false);setShowReceipts(true);}}/>}
      <nav className="workspace-switch mobile-workspace-switch" aria-label="主要功能"><button aria-pressed={!showTodos} onClick={() => setShowTodos(false)}>日记</button><button aria-pressed={showTodos} onClick={() => setShowTodos(true)}>计划</button></nav>
      <header className="topbar">{showTodos && <h1 className="plan-page-title">计划</h1>}<div hidden={showTodos} className="date-control"><button type="button" onClick={() => setDate(addDays(date, -1))} aria-label="前一天"><ChevronLeft /></button><GlassDate label="日记日期" dateOnly required date={date} onChange={d=>{if(d)setDate(d);}}/><button type="button" onClick={() => setDate(addDays(date, 1))} aria-label="后一天"><ChevronRight /></button></div><div className="top-actions"><div hidden={showTodos} className="desktop-status"><StatusBadge status={status} /></div><button type="button" className="icon-button" onClick={() => setTheme(theme === "light" ? "dark" : "light")} aria-label={theme === "light" ? "切换到深色主题" : "切换到浅色主题"}>{theme === "light" ? <Moon /> : <Sun />}</button><button hidden={showTodos} type="button" className="save-button" onClick={() => void saveNow(diaryRef.current,true)} disabled={status === "saving" || status === "loading" || status === "conflict"}><Save />立即保存</button></div></header>
      <div hidden={showTodos} className="mobile-status"><StatusBadge status={status} /></div>
      {!showTodos&&(saveError||issues.length>0)&&<div className="save-problem" role="alert"><p>{saveError||'内容未通过校验，草稿已保留'}</p>{issues.slice(0,5).map(issue=><button key={issue.path} type="button" className="quiet-button" onClick={()=>focusIssue(issue)}>{issue.message}</button>)}{saveError&&!issues.length&&<button className="quiet-button" onClick={()=>void saveNow(diaryRef.current,true)}>重试保存</button>}</div>}
      {!showTodos&&refreshWarning&&<div className="refresh-warning" role="status">{refreshWarning}<button className="quiet-button" onClick={()=>void refreshContext(date).then(()=>setRefreshWarning('')).catch(()=>{})}>重试刷新</button></div>}
      {reauth&&<GlassDialog label="重新登录" onClose={()=>setReauth(false)}><p className="reauth-note">登录已失效，编辑内容已保留。请使用原账号重新登录。</p><Login onAuth={async()=>{const me=await api.auth.me();if(me.id!==authState.user?.id){await api.auth.logout();setSaveError('请登录原账号后继续保存');return;}setReauth(false);await saveNow();}}/></GlassDialog>}
      {actionError && <p role="alert">{actionError}</p>}
      <div className="workspace-footer">
        <UnifiedCapture compactDesktop={showTodos} entityContext={common} hidden={!showTodos && !showReceipts && activeTab === 4} bottomNav={!showTodos && !showReceipts} onSave={saveCapture} onOpen={ref => void openRecord(ref)} fullscreen={fullscreen} onToggleFullscreen={() => setFullscreen(f => !f)} />
        {mobileLayout&&!showTodos&&!showReceipts&&diaryNavigation}
      </div>
      <div className="workspace-root plan-workspace" hidden={!showTodos}><TodoPanel active={showTodos} onNavigationChange={setPlanNavigation} entityContext={common} toolbarAction={planToolbarAction} onExpand={compactBrowse.expand} fullscreen={fullscreen} onToggleFullscreen={() => setFullscreen(f => !f)} date={planClock().date} source={actionSource} revision={actionsRevision} focusId={focusRecord?.kind === 'todo' ? focusRecord.id : undefined} prepare={prepareAction} changed={reloadAfterAction} onOpen={ref => void openRecord(ref)} onClose={() => setShowTodos(false)} /></div>
      <div className="workspace-root diary-workspace" hidden={showTodos}>
      <div className="todo-entry-actions"><button type="button" className="quiet-button" onClick={() => setShowReceipts(true)}><BookOpen size={18} />每日小票 · 查看收藏</button></div>
      {showReceipts ? (status === 'loading' || diary.date !== date ? <p role="status">正在整理这一天的小票…</p> : <ReceiptCollection key={date} diary={diary} saved={status === 'saved'} onClose={() => setShowReceipts(false)} onWrite={()=>{setShowReceipts(false);selectTab(0);requestAnimationFrame(()=>window.document.dispatchEvent(new Event("diary-add-event")));}} />) : <>
      {conflict && <ConflictBanner conflict={conflict} onRemote={() => { updateDiary(conflict.remote); versionRef.current = conflict.remoteVersion; setVersion(conflict.remoteVersion); lastSaved.current = JSON.stringify(conflict.remote); localStorage.removeItem(`diary.draft.${date}`); conflictRef.current = null; setConflict(null); setStatus("saved"); }} onLocal={() => { versionRef.current = conflict.remoteVersion; setVersion(conflict.remoteVersion); updateDiary(conflict.local); conflictRef.current = null; setConflict(null); setStatus("dirty"); }} />}
      <div className="workspace-layout">
        {!mobileLayout&&diaryNavigation}
        <div className="workspace-track" ref={trackRef} onScroll={onTrackScroll}>{tabs.map((tab, index) => <div id={`panel-${tab.id}`} role="tabpanel" aria-hidden={activeTab !== index} inert={activeTab !== index} tabIndex={activeTab === index ? 0 : -1} data-active={activeTab === index} className={`workspace-panel${index === 4 ? " full-page" : ""}`} key={tab.id}>{panel(index)}</div>)}</div>
      </div>
      </>}
      </div>
    </main>

    <aside className="context-rail" aria-label="本周概览">
      <section><div className="context-title"><CalendarDays /><h2>本周</h2></div><div className="week-stats"><strong>{week?.entries.length || 0}</strong><span>天有记录</span></div><div className="mini-days">{currentWeekDates.map((item) => <button type="button" key={item} className={item === date ? "active" : ""} onClick={() => setDate(item)}><span>{new Date(`${item}T00:00:00Z`).getUTCDate()}</span><i className={recordedDates.has(item) ? "filled" : ""} /></button>)}</div></section>
      <section><div className="context-title"><Sparkles /><h2>周复盘</h2></div><p>汇总共享的每日记录，结果写入独立子目录，不覆盖项目方舟。</p><button type="button" className="summary-button" disabled={summaryLoading} onClick={async () => { setSummaryLoading(true); setSummaryMessage(""); try { const result = await api.summarize(date, true); setSummaryMessage(result.ok ? `已生成${result.mode === "ai" ? " AI" : "规则版"}周复盘` : result.reason || "未生成"); } catch (error) { setSummaryMessage(error instanceof Error ? error.message : "生成失败"); } finally { setSummaryLoading(false); } }}><Sparkles />{summaryLoading ? "正在整理" : "生成本周复盘"}</button>{summaryMessage && <p className="summary-message" role="status">{summaryMessage}</p>}</section>
      <section><div className="context-title"><Link2 /><h2>线索库</h2></div><p><strong>{entities.length}</strong> 个实体已经可以反查。</p><div className="type-counts">{entityTypes.map((type) => <span key={type}>{TYPE_LABEL[type]} <b>{entities.filter((entity) => entity.type === type).length}</b></span>)}</div></section>
    </aside>
    {printedReceipts.length > 0 && <ReceiptNotice key={`${printedReceipts[0].date}:${printedReceipts[0].id}`} receipts={printedReceipts} onClose={() => setPrintedReceipts([])} onOpen={() => { setDate(printedReceipts[0].date); setShowReceipts(true); setPrintedReceipts([]); }} />}
  </div></RecordContext.Provider>;
}
