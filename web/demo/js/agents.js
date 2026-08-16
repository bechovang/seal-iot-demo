/* =============================================================================
   agents.js — Multi-Agent Industrial Operations Orchestration (Track C).
   Implements the suggested agent topology:
     Operations Supervisor · IoT Observation · Maintenance · Production ·
     Safety · Factory Action (Tools) · Auditor (verification)
   Plus a planner that runs the What-If digital twin and an objective scorer
   before committing any tool call (neuro-symbolic safety shield).
   Each task runs the acceptance loop, logs a full audit trace, writes
   work-orders with idempotency + verification, and distills to runbook wiki.
============================================================================= */

/* ---------------- Tool / API layer (Factory Action backend) ---------------- */
class ToolLayer {
  constructor(emitter) {
    this.emitter = emitter; // logs tool calls
    this.workOrders = [];   // persistent idempotency table
    this.incidents = [];
    this.notifications = [];
    this.approvals = [];
    this.timeoutMode = false; // simulate tool timeout
    this.idCounter = 1000;
  }

  _log(action, detail, meta = {}) {
    this.emitter({ type: 'tool', action, detail, meta });
  }

  _mkId(prefix) { return prefix + '-' + (++this.idCounter); }

  // idempotency-aware create
  createWorkOrder({ device, content, priority, sourceTask }) {
    // check duplicate by (device, content, sourceTask)
    const dup = this.workOrders.find(w => w.device === device &&
      w.content === content && (w.sourceTask === sourceTask || sourceTask === undefined));
    if (dup && dup.status !== 'cancelled') {
      this._log('TW_DEDUP', `Dedup hit — work order ${dup.id} already exists`, { dedup: true });
      this.emitter({ type: 'verification', detail: `Idempotency: reuse ${dup.id}, not creating duplicate` });
      return { id: dup.id, dedup: true };
    }
    const wo = {
      id: this._mkId('WO'), device, content, priority, sourceTask,
      status: 'CREATED', createdAt: new Date().toISOString(), verification: null,
    };
    this.workOrders.push(wo);
    if (this.timeoutMode) {
      // packet likely landed server-side, but the ACK was lost → caller must NOT blind-retry
      this._log('TOOL_CREATE_WORKORDER', `POST /ops/workorders body={device:${device}} ⚠ TIMEOUT — no ACK received (request may have landed)`, { id: wo.id, timeout: true });
      return { id: null, timeout: true };
    }
    this._log('TOOL_CREATE_WORKORDER', `POST /ops/workorders body={device:${device}, content:"${content}", priority:${priority}}`, { id: wo.id });
    return { id: wo.id, dedup: false };
  }

  createIncident({ device, summary, severity }) {
    const inc = { id: this._mkId('INC'), device, summary, severity, status: 'OPEN', createdAt: new Date().toISOString() };
    this.incidents.push(inc);
    this._log('TOOL_CREATE_INCIDENT', `POST /ops/incidents severity=${severity}`, { id: inc.id });
    return inc;
  }

  notify({ channel, to, message, ref }) {
    this.notifications.push({ channel, to, message, ref, ts: new Date().toISOString() });
    this._log('TOOL_NOTIFY', `→ ${channel} → ${to} :: "${message}"`, { ref });
  }

  requestApproval({ title, detail, ref, options }) {
    const ap = { id: this._mkId('APPR'), title, detail, ref, options: options || ['APPROVE', 'DENY', 'OVERRIDE'], status: 'PENDING', ts: new Date().toISOString() };
    this.approvals.push(ap);
    this._log('TOOL_REQUEST_APPROVAL', `${title} → pending human approval`, { id: ap.id });
    this.emitter({ type: 'approval', approval: ap });
    return ap;
  }

  // verification: read back created WO
  verifyWorkOrder(id) {
    const wo = this.workOrders.find(w => w.id === id);
    this._log('TOOL_GET_WORKORDER', `GET /ops/workorders/${id}`, { id });
    if (!wo) { this.emitter({ type: 'verification', detail: `⚠ verify failed: ${id} not found` }); return { ok: false }; }
    // simulated read-back confirmation
    const ok = true;
    wo.verification = { ok, verifiedAt: new Date().toISOString() };
    wo.status = 'VERIFIED';
    this.emitter({ type: 'verification', detail: `✓ Read-back /ops/workorders/${id} → device=${wo.device} status=${wo.status}. MATCH expected.` });
    return { ok, wo };
  }

  // simulate a timeout / failure for tool -> agent must re-plan (Scenario 3)
  setToolTimeout(on) { this.timeoutMode = on; }
}

/* ---------------- Agent base ---------------- */
class AgentBase {
  constructor(id, name, role, emitter) {
    this.id = id;
    this.name = name;
    this.role = role;
    this.emitter = emitter;
  }
  say(msg, kind = 'agent') { this.emitter({ type: 'agent', agent: this.name, agentId: this.id, detail: msg, kind }); }
  sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  async run(ctx) { throw new Error('not implemented'); }
}

/* ---------------- Concrete agents ---------------- */
class IoTAgent extends AgentBase {
  async run(ctx) {
    this.say(`Reading MQTT telemetry for ${ctx.device} and correlated assets...`, 'iot');
    await this.sleep(60);
    const snap = ctx.snapshot(ctx.device);
    const metrics = ctx.sim.sims[ctx.device].cfg.metrics;
    let summary = '';
    metrics.forEach(m => {
      const v = snap.values[m];
      summary += `${m}=${v}; `;
    });
    // freshness check
    const fresh = (Date.now() - snap.ts) < 1500;
    ctx.telemetry = snap;
    ctx.fresh = fresh;
    ctx.anomalyMap = metrics.map(m => ({ metric: m, value: snap.values[m], status: this._flag(ctx.device, m, snap.values[m]) }));
    this.say(`∑ ${ctx.device}: ${summary}stream fresh=${fresh ? 'YES' : 'STALE'}`, 'summary');
    ctx.observations = ctx.anomalyMap.filter(a => a.status !== 'NORMAL');
    return ctx;
  }
  _flag(device, m, v) {
    // threshold-based triage (anomaly backbone: ADWIN-Kalman in dashboard layer)
    const flags = {
      MOTOR_01: { current: 65, vibration: 2.6, temperature: 72 },
      LINE_01: { current: 175, voltage: 380 },
      CONVEYOR_01: { load: 300 },
      PRESS_01: { pressure: 8 },
      GAS_01: { gas: 28 },
      PROBE_01: { temperature: 510 },
    };
    const devCfg = flags[device] || {};
    return (devCfg[m] && v > devCfg[m]) ? 'WARN' : 'NORMAL';
  }
}

class MaintenanceAgent extends AgentBase {
  async run(ctx) {
    this.say(`Drafting inspection / maintenance plan for ${ctx.device} using known failure modes + history...`, 'maint');
    await this.sleep(50);
    ctx.workOrderContent = this._plan(ctx.device, ctx.anomalyMap);
    this.say(`📋 Proposed content: "${ctx.workOrderContent}" (references ${ctx.device} tech doc & SOP set)`, 'summary');
    ctx.maintHistory = this._history(ctx.device);
    return ctx;
  }
  _plan(device, anomalies) {
    const extra = anomalies ? anomalies.map(a => `check ${a.metric}`).join('; ') : '';
    return `Scheduled inspection of ${device}${extra ? ' (' + extra + ')' : ''} before next shift`;
  }
  _history(device) { return `2 prior WO for ${device} in 30 days; last routine at T-6 days`; }
}

class ProductionAgent extends AgentBase {
  async run(ctx) {
    this.say(`Assessing impact of ${ctx.device} on production line & current order queue...`, 'prod');
    await this.sleep(45);
    ctx.prodImpact = { delta: this._impact(ctx.device), note: '' };
    ctx.prodImpact.note = ctx.prodImpact.delta < 0 ? 'Would interrupt an urgent order (LOW safety margin).' : 'Meets current production window with slack.';
    this.say(`Impact: ${ctx.prodImpact.delta >= 0 ? 'NO' : '⚠ negative'} production impact. ${ctx.prodImpact.note}`, 'summary');
    return ctx;
  }
  _impact(device) {
    // production tolerates MOTOR/PRESS but hates LINE/CONVEYOR outages
    switch (device) {
      case 'MOTOR_01': return -5;
      case 'CONVEYOR_01': return -30;
      case 'LINE_01': return -25;
      case 'PRESS_01': return -10;
      case 'PROBE_01': return -8;
      default: return 0;
    }
  }
}

class SafetyAgent extends AgentBase {
  async run(ctx) {
    this.say(`Analyzing safety envelope for ${ctx.device} (limits, human-exposure, escalation thresholds)...`, 'safety');
    await this.sleep(50);
    ctx.safety = this._assess(ctx.device, ctx.anomalyMap || []);
    this.say(`${ctx.safety.verdict}. ${ctx.safety.explain}`, 'summary');
    return ctx;
  }
  _assess(device, anomalies) {
    const thresholds = {
      MOTOR_01: { temperature: 75, vibration: 3.0, current: 70 },
      GAS_01: { gas: 30 },
      PRESS_01: { pressure: 8 },
      LINE_01: { current: 180 },
      PROBE_01: { temperature: 520 },
      CONVEYOR_01: { load: 320 },
    };
    const t = thresholds[device] || {};
    let breached = [];
    (anomalies || []).forEach(a => { if (t[a.metric] && a.value > t[a.metric]) breached.push(`${a.metric}(${a.value}>${t[a.metric]})`); });
    if (breached.length) return { verdict: '🚨 CRITICAL', breached, explain: `Exceeds safety limit: ${breached.join(', ')} → requires human approval / immediate action.` };
    return { verdict: 'WITHIN LIMITS', breached, explain: 'Values inside safety envelope; safe to continue but recommend monitoring.' };
  }
}

class PlannerAgent extends AgentBase {
  async run(ctx) {
    this.say(`Generating candidate actions and simulating each on the What-If digital twin before committing...`, 'planner');
    await this.sleep(60);
    const sim = ctx.sim;
    const whatIf = ctx.whatIf;
    const current = sim.sims[ctx.device].values;
    const anomalies = ctx.anomalyMap || [];
    const candidates = this._candidates(ctx.device, ctx.safety, ctx.anomalyMap);

    const scored = candidates.map(c => {
      const effect = this._effect(ctx.device, c.delta, current);
      const score = this._score(effect, anomalies, c);
      return { ...c, effect, score };
    });
    scored.sort((a, b) => b.score - a.score);
    ctx.candidates = scored;
    ctx.chosen = scored[0];
    this.say(`🧠 Simulated ${candidates.length} futures on twin → chose "${scored[0].action}" (score ${scored[0].score.toFixed(2)}).`, 'decision');
    return ctx;
  }
  _candidates(device, safety, anomalies) {
    // base scenario-agnostic actions
    const list = [
      { action: 'Monitoring_only', delta: {} },
      { action: 'reduce_load_20%', delta: { load: -20 } },
      { action: 'increase_cooling', delta: { temperature: -8 } },
    ];
    if (device === 'GAS_01') list.push({ action: 'purge_ventilation', delta: { gas: -40 } });
    if (device === 'LINE_01') list.push({ action: 'emergency_isolate', delta: { current: -30 } });
    if (device === 'MOTOR_01') list.push({ action: 'planned_shutdown', delta: { temperature: -25 } });
    return list;
  }
  _effect(device, delta, current) {
    // predicted relief per metric after the action (first-order twin model)
    const metricChanges = {};
    DEVICES[device].metrics.forEach(m => {
      const applied = Math.abs(delta[m] || 0) / 40;
      metricChanges[m] = Math.min(1, applied);
    });
    return metricChanges;
  }
  _score(effect, anomalies, c) {
    // multi-objective: safety relief dominates; production/energy/cost secondary
    let score = 0;
    anomalies.forEach(a => {
      const relief = effect[a.metric] || 0;
      score += 0.55 * relief;                                            // safety
      score += 0.15 * (a.metric === 'load' ? relief : 0);                // production
      score += 0.15 * (a.metric === 'current' ? relief : 0);             // energy
      score += 0.15 * (a.metric === 'pressure' ? relief : 0);            // process
    });
    if (anomalies.length === 0) score = 0.4; // monitoring baseline
    return score;
  }
}

class FactoryActionAgent extends AgentBase {
  async run(ctx) {
    const chosen = ctx.chosen || { action: 'apply_runbook_sop' };
    const safety = ctx.safety || { verdict: 'WITHIN LIMITS', explain: 'Runbook-matched SOP. No explicit safety override.' };
    this.say(`Committing chosen action via Tool/API, then reading back to verify (idempotent retry-safe)...`, 'action');
    await this.sleep(40);
    const tool = ctx.tools;
    // Guard: if safety critical, request approval first
    if (safety.verdict.includes('CRITICAL')) {
      this.say(`Safety-critical → routing to human approval gate before executing tool.`, 'approval');
      tool.requestApproval({
        title: `Approve ${chosen.action} on ${ctx.device}`,
        detail: `${safety.explain} Risk: ${ctx.device} above limit. Candidate: ${chosen.action}.`,
        ref: `${ctx.device}/${ctx.taskType}`,
        options: ['APPROVE', 'ESCALATE_TO_SHUTDOWN', 'DENY']
      });
      contextNeedsApproval.set(ctx.taskId, chosen);
    }
    // create work order (with retry/timeout handling)
    let wo = tool.createWorkOrder({ device: ctx.device, content: ctx.workOrderContent, priority: safety.verdict.includes('CRITICAL') ? 'HIGH' : 'MEDIUM', sourceTask: ctx.taskId });
    if (wo.timeout) {
      this.say(`⚠ Tool /ops/workorders timed out (no ACK). Blind retry would duplicate → auditing + retrying with same idempotency key...`, 'tool');
      await this.sleep(80);
      wo = tool.createWorkOrder({ device: ctx.device, content: ctx.workOrderContent, priority: safety.verdict.includes('CRITICAL') ? 'HIGH' : 'MEDIUM', sourceTask: ctx.taskId });
      this.say(`↻ Retry resolved via server-side dedup → ${wo.id} reused, zero duplicates created. Transient fault cleared.`, 'decision');
      tool.setToolTimeout(false);
    }
    ctx.workOrderId = wo.id;
    const verify = tool.verifyWorkOrder(ctx.workOrderId);
    ctx.verification = verify;
    return ctx;
  }
}
const contextNeedsApproval = new Map();

class SupervisorAgent extends AgentBase {
  async run(ctx) {
    this.say(`[ORCHESTRATOR] Received request → decomposing into subtasks and dispatching agents...`, 'sup');
    ctx.audit = [];
    ctx.log = (kind, detail, agent) => this.emitter({ type: 'trace', kind, detail, agent, taskId: ctx.taskId });
    return ctx;
  }
}

/* ---------------- Orchestrator: ties together a task pipeline ---------------- */
class Orchestrator {
  constructor(tools, sim, emitter) {
    this.tools = tools;
    this.sim = sim;
    this.emitter = emitter;
    this.auditTrail = [];
    this.agents = {
      supervisor: new SupervisorAgent('sup', 'Ops Supervisor', 'orchestrator', this._emit.bind(this)),
      iot: new IoTAgent('iot', 'IoT Observation', 'telemetry', this._emit.bind(this)),
      maint: new MaintenanceAgent('maint', 'Maintenance', 'specialist', this._emit.bind(this)),
      prod: new ProductionAgent('prod', 'Production Planning', 'specialist', this._emit.bind(this)),
      safety: new SafetyAgent('safety', 'Safety', 'specialist', this._emit.bind(this)),
      planner: new PlannerAgent('planner', 'AI Planner', 'decision', this._emit.bind(this)),
      action: new FactoryActionAgent('action', 'Factory Action', 'tool-exec', this._emit.bind(this)),
    };
    this.whatIf = new WhatIfSim();
    this.tools._sim = this.sim;
    this.busy = false;
  }

  _emit(ev) { this.emitter(ev); }

  snapshot(device) { return this.sim.sims[device].snapshot(); }

  async run(device, taskType, userText) {
    if (this.busy) { this.emitter({ type: 'info', detail: 'Orchestrator busy — queueing request.' }); return; }
    this.busy = true;
    const taskId = 'T' + (++this.counter || (this.counter = 0)).toString().padStart(3, '0');
    const ctx = { taskId, device, taskType, userText, sim: this.sim, tools: this.tools, whatIf: this.whatIf, snapshot: this.snapshot.bind(this) };
    this.emitter({ type: 'task_start', taskId, device, taskType, userText });

    // 1. Runbook lookup (knowledge compounding)
    const rb = lookupRunbook(device, taskType);
    if (rb) {
      ctx.runbookHit = true;
      this.emitter({ type: 'info', detail: `⚡ Runbook hit (${rb.id}) — knowledge compounding, applying distilled SOP (${rb.occurrences} prior occurrences).` });
      ctx.workOrderContent = rb.content;
      // SOP reuse accelerates planning, but the safety gate is NEVER skipped
      await this.agents.iot.run(ctx);
      await this.agents.safety.run(ctx);
    } else {
      this.emitter({ type: 'info', detail: `No runbook — running full multi-agent reasoning + causal + what-if pipeline.` });
      await this.agents.supervisor.run(ctx);
      await this.agents.iot.run(ctx);
      await this.agents.maint.run(ctx);
      await this.agents.safety.run(ctx);
      await this.agents.prod.run(ctx);
      await this.agents.planner.run(ctx);
    }
    await this.agents.action.run(ctx);

    // runbook distillation on success for new pattern
    if (!ctx.runbookHit && ctx.verification && ctx.verification.ok) {
      distillRunbook({ device: ctx.device, taskType, content: ctx.workOrderContent, id: `${ctx.device}/${taskType}`, outcome: 'resolved' });
      this.emitter({ type: 'info', detail: `🧠 Distilled new runbook entry for ${ctx.device} → knowledge compounding.` });
    }

    this.emitter({ type: 'task_end', taskId, device, verdict: ctx.verification && ctx.verification.ok ? 'VERIFIED' : 'FAILED' });
    this.busy = false;
    return ctx;
  }
}

/* ---------------- Runbook wiki (knowledge compounding) ---------------- */
// Seed mặc định — dùng làm bộ nhớ khởi tạo cho lần đầu chạy trên 1 trình duyệt.
const RUNBOOK_SEED = [
  { id: 'motor-overheat-fan', device: 'MOTOR_01', symptoms: ['temperature', 'vibration'], occurrences: 3,
    content: 'Reduce load 20% + increase cooling + verify cooling fan → monitor 15s; if persists escalate.' },
];
// Lưu tri thức runbook vào localStorage (Hướng A) → reload/xoá tab vẫn còn đúng máy.
const RUNBOOKS_KEY = 'aiops_runbooks_v1';
let RUNBOOKS = (() => {
  try {
    const raw = localStorage.getItem(RUNBOOKS_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) {
        return arr.map(r => ({
          id: r.id, device: r.device, taskType: r.taskType || '',
          symptoms: r.symptoms || [], occurrences: +r.occurrences || 1,
          content: r.content || '', created: r.created || new Date().toISOString(),
          window: r.window || null,
        }));
      }
    }
  } catch (e) { /* localStorage unavailable/corrupt → fallback seed */ }
  return RUNBOOK_SEED.map(r => ({ ...r, taskType: r.taskType || '', created: r.created || new Date().toISOString() }));
})();
const persistRunbooks = () => {
  try { localStorage.setItem(RUNBOOKS_KEY, JSON.stringify(RUNBOOKS)); }
  catch (e) { /* quota/denied → bỏ qua, chỉ mất persist */ }
  // best-effort: nếu đã chọn folder wiki thì đồng bộ file ra đĩa (không chặn UI)
  try { if (typeof flushWikiToFolder === 'function' && _wikiDir) flushWikiToFolder(_wikiDir).catch(() => {}); }
  catch (e) { /* ignore */ }
};
// Nút reset tri thức (dùng trong demo): trả wiki về seed ban đầu.
const resetRunbooks = () => {
  RUNBOOKS = RUNBOOK_SEED.map(r => ({ ...r, taskType: r.taskType || '', created: r.created || new Date().toISOString() }));
  persistRunbooks();
  return RUNBOOKS;
};
const lookupRunbook = (device, taskType) => {
  const hit = RUNBOOKS.find(r => r.device === device && (!r.taskType || r.taskType === taskType)) || RUNBOOKS.find(r => r.device === device);
  return hit ? { ...hit } : null;
};
const distillRunbook = (entry) => {
  const slug = entry.id.toLowerCase();
  if (!RUNBOOKS.find(r => r.id === entry.id)) {
    RUNBOOKS.push({ id: entry.id, device: entry.device, taskType: entry.taskType, symptoms: entry.symptoms || [], occurrences: 1, content: entry.content, created: new Date().toISOString() });
  } else {
    const r = RUNBOOKS.find(x => x.id === entry.id); r.occurrences++;
  }
  persistRunbooks();
};

/* Ghi một node tri thức bất kỳ vào wiki (upsert theo id). Dùng cho alarm digest
   1 phút/lần: node có taskType='alarm-digest', window={from,to} để chat AI lọc
   theo khung thời gian câu hỏi. Giữ tối đa 30 node digest (ring, bỏ cũ nhất). */
const DIGEST_CAP = 30;
const pushWikiNode = (node) => {
  const i = RUNBOOKS.findIndex(r => r.id === node.id);
  const full = {
    id: node.id, device: node.device || 'FACTORY', taskType: node.taskType || 'note',
    symptoms: node.symptoms || [], occurrences: node.occurrences || 1,
    content: node.content || '', created: node.created || new Date().toISOString(),
    window: node.window || null,
  };
  if (i >= 0) RUNBOOKS[i] = { ...RUNBOOKS[i], ...full };
  else RUNBOOKS.push(full);
  // ring-cap riêng cho digest để wiki không phình vô hạn (1 node/phút)
  const digests = RUNBOOKS.filter(r => r.taskType === 'alarm-digest');
  if (digests.length > DIGEST_CAP) {
    const oldest = digests[0];
    RUNBOOKS = RUNBOOKS.filter(r => r.id !== oldest.id);
  }
  persistRunbooks();
  return full;
};

/* ---------- Lưu wiki ra FOLDER trên đĩa (File System Access API) ----------
   Cho phép dashboard tĩnh ghi từng runbook thành file .json vào 1 folder do người
   dùng chọn (vd C:\...\demo seal\wiki). Handle folder được cache trong IndexedDB
   để các lần distill sau tự ghi lại mà không cần chọn lại folder. */
const WIKI_DB = 'aiops-wiki', WIKI_STORE = 'handles';
let _wikiDir = null; // FileSystemDirectoryHandle đang active

function _idb() {
  return new Promise((res, rej) => {
    if (typeof indexedDB === 'undefined') return rej(new Error('no idb'));
    const rq = indexedDB.open(WIKI_DB, 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore(WIKI_STORE);
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}
async function _storeHandle(h) {
  try {
    const db = await _idb();
    const tx = db.transaction(WIKI_STORE, 'readwrite');
    tx.objectStore(WIKI_STORE).put(h, 'wikiDir');
  } catch (e) { /* private mode / denied */ }
}
async function _loadHandle() {
  try {
    const db = await _idb();
    return await new Promise((res, rej) => {
      const tx = db.transaction(WIKI_STORE, 'readonly');
      const rq = tx.objectStore(WIKI_STORE).get('wikiDir');
      rq.onsuccess = () => res(rq.result || null);
      rq.onerror = () => rej(rq.error);
    });
  } catch (e) { return null; }
}

async function _writeFile(dir, name, text) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(text);
  await w.close();
}

/* Ghi toàn bộ wiki ra folder: mỗi runbook 1 file rb-<id>.json + _index.json tổng hợp. */
async function flushWikiToFolder(dir) {
  const d = dir || _wikiDir;
  if (!d) return 0;
  let n = 0;
  for (const r of RUNBOOKS) {
    const name = 'rb-' + String(r.id).toLowerCase().replace(/[^a-z0-9-_]+/g, '-') + '.json';
    await _writeFile(d, name, JSON.stringify({ ...r, source: 'distilled', savedAt: new Date().toISOString() }, null, 2));
    n++;
  }
  await _writeFile(d, '_index.json', JSON.stringify({
    count: RUNBOOKS.length, savedAt: new Date().toISOString(),
    runbooks: RUNBOOKS.map(r => ({ id: r.id, device: r.device, occurrences: r.occurrences })),
  }, null, 2));
  return n;
}

/* Chọn folder (user gesture) rồi cache handle; trả về số file đã ghi. */
async function pickWikiFolder() {
  if (typeof showDirectoryPicker !== 'function') {
    throw new Error('Trình duyệt không hỗ trợ File System Access (dùng Chrome/Edge).');
  }
  const dir = await showDirectoryPicker({ mode: 'readwrite' });
  // xin quyền ghi (một số trình duyệt cần verify)
  if (dir.requestPermission) {
    const p = await dir.requestPermission({ mode: 'readwrite' });
    if (p !== 'granted') throw new Error('Quyền ghi folder bị từ chối.');
  }
  _wikiDir = dir;
  await _storeHandle(dir);
  return flushWikiToFolder(dir);
}

/* Tự động khôi phục folder đã chọn trước đó (gọi lúc boot, không cần click). */
async function restoreWikiFolder() {
  try {
    const h = await _loadHandle();
    if (!h) return null;
    if (h.queryPermission) {
      let p = await h.queryPermission({ mode: 'readwrite' });
      if (p !== 'granted' && h.requestPermission) {
        // không tự popup được ngoài user gesture → để nút bấm kích hoạt
        _wikiDir = h; return h;
      }
    }
    _wikiDir = h;
    await flushWikiToFolder(h); // đồng bộ wiki hiện tại ra folder
    return h;
  } catch (e) { return null; }
}

window.Orchestrator = Orchestrator;
window.ToolLayer = ToolLayer;
window.getRunbooks = () => RUNBOOKS;
window.pushWikiNode = pushWikiNode;
window.resetRunbooks = resetRunbooks;
window.pickWikiFolder = pickWikiFolder;
window.restoreWikiFolder = restoreWikiFolder;
window.flushWikiToFolder = flushWikiToFolder;