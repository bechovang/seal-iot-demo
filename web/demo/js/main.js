/* =============================================================================
   main.js — boots the simulated MQTT fabric, wires the multi-agent orchestrator
   and renders the live control-room dashboard + [engineering deep-dive] viewers.
============================================================================= */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));

  /* ------------- global state ------------- */
  const state = {
    broker: null, orch: null, tools: null,
    kpi: { wos: 0, approvals: 0, incidents: 0, anomalies: 0, learning: getRunbooks().length },
    twinCandidates: [], causalEdges: [],
  };

  /* ------------- Agent Fleet & Runbook tracking ------------- */
  const fleet = {
    agents: {},   // name -> { msgs, last, kind, activeUntil }
    tasks: 0, decisions: 0, verifs: 0, toolCalls: 0,
    woCreate: 0, dedup: 0, apprReq: 0, toolActiveUntil: 0,
  };
  const runbookLog = [];   // { ts, kind: hit|distill|apply, text }
  let pendingRunbookHit = null;
  const FLEET_PIPELINE = [
    ['Ops Supervisor'],
    ['IoT Observation'],
    ['Maintenance', 'Production Planning', 'Safety'],
    ['AI Planner'],
    ['Factory Action'],
  ];
  const AGENT_ROLES = {
    'Ops Supervisor': 'orchestrator', 'IoT Observation': 'telemetry',
    'Maintenance': 'specialist', 'Production Planning': 'specialist',
    'Safety': 'safety-gate', 'AI Planner': 'decision', 'Factory Action': 'tool-exec',
  };
  const esc = s => String(s).replace(/</g, '‹').replace(/>/g, '›');

  const clockEl = $('#clock');
  setInterval(() => {
    const d = new Date();
    clockEl.textContent = d.toLocaleTimeString('en-GB');
  }, 1000);

  /* ------------- edge intelligence rigs: ADWIN + Kalman per signal ------------- */
  const RANGES = {
    MOTOR_01: { current: [25, 75], vibration: [0.5, 4], temperature: [40, 95] },
    LINE_01: { voltage: [370, 450], current: [60, 190] },
    CONVEYOR_01: { speed: [0.8, 1.6], load: [120, 340] },
    PRESS_01: { pressure: [3, 9] },
    GAS_01: { gas: [5, 70] },
    PROBE_01: { temperature: [380, 540] },
  };
  const driftRigs = {}; const kalmanRigs = {}; const causalTracker = new CausalTracker();
  const driftHistory = {}; const kalmanHistory = {}; let causalNodes = [];
  Object.keys(DEVICES).forEach(d => {
    DEVICES[d].metrics.forEach(m => {
      if (!driftRigs[d]) driftRigs[d] = {};
      if (!kalmanRigs[d]) kalmanRigs[d] = {};
      driftRigs[d][m] = new ADWIN(0.002, 25);
      kalmanRigs[d][m] = new Kalman(0.005, 0.2);
      driftHistory[d + '.' + m] = [[], []]; // [tick], [drift?]
      kalmanHistory[d + '.' + m] = [[], []];
      causalTracker.push(d + '.' + m, 0);
    });
  });
  const normVal = (d, m, v) => { const [lo, hi] = RANGES[d][m]; return Math.max(0, Math.min(1, (v - lo) / (hi - lo))); };

  /* ------------- event bus -> UI ------------- */
  const emitter = ev => {
    if (!ev || !ev.type) return;
    trackFleet(ev);
    switch (ev.type) {
      case 'agent': traceAgent(ev); break;
      case 'tool': traceTool(ev); break;
      case 'verification': traceVerif(ev); break;
      case 'info': trace(ev.type, ev.detail, ev.taskId || 'CORE'); break;
      case 'task_start': onTaskStart(ev); break;
      case 'task_end': onTaskEnd(ev); break;
      case 'approval': renderApprovals(); break;
      case 'trace': trace(ev.kind, ev.agent, ev.detail); break;
    }
  };

  /* trace render */
  let traceSeq = 0;
  function traceRow(kind, agent, detail, extraCls) {
    const body = $('#traceBody');
    const div = document.createElement('div');
    div.className = 'trace-row';
    div.innerHTML = `<span class="num">${String(++traceSeq)}</span>` +
      `<span class="kind-badge ${clsFor(kind)}">${kind}</span>` +
      `<span class="${agentCls(agent)}">${agent}</span>` +
      `<span>${detail.replace(/</g,'‹')}</span>`;
    if (extraCls) div.querySelector('span:nth-child(4)').classList.add(extraCls);
    body.prepend(div);
    while (body.children.length > 120) body.lastChild.remove();
  }
  const clsFor = k => k === 'tool' ? 'tr-tool' : k === 'verification' ? 'tr-verif' : k === 'summary' ? '' : 'tr-trace';
  const agentCls = a => 'tr-' + (String(a).toLowerCase().match(/supervisor|iot|maintenance|production|safety|planner|factory/) || ['info'])[0];
  const traceAgent = ev => { const badge = ev.kind === 'summary' ? 'SUMMARY' : ev.kind === 'decision' ? 'DECIDE' : ev.kind === 'approval' ? 'APPROVE' : 'AGENT'; traceRow(badge, ev.agent, ev.detail); if (ev.kind === 'decision') syncObjectiveFromTrace(ev); };
  const traceTool = ev => traceRow('TOOL', ev.action, ev.detail);
  const traceVerif = ev => traceRow('VERIFY', 'Auditor', ev.detail);
  const trace = (kind, agent, detail) => traceRow(kind.toUpperCase(), agent, detail);

  /* ------------- device live grid ------------- */
  function renderDeviceGrid() {
    const g = $('#deviceGrid'); g.innerHTML = '';
    Object.keys(DEVICES).forEach(d => {
      const sim = state.broker.sims[d];
      const norms = { MOTOR_01: { current: 45, vibration: 1.5, temperature: 55 }, LINE_01: { voltage: 415, current: 120 }, CONVEYOR_01: { speed: 1.2, load: 180 }, PRESS_01: { pressure: 5.2 }, GAS_01: { gas: 12 }, PROBE_01: { temperature: 420 } };
      const anom = Object.keys(sim.faults).length > 0;
      const card = document.createElement('div');
      card.className = 'dev-card' + (anom ? ' anom' : '') + (anomEvidence(d) ? ' warn' : '');
      card.id = 'dev-' + d;
      card.innerHTML = `<div class="dev-head"><span class="dev-name">${d}</span><span class="dev-status ${anom ? 'anom' : 'ok'}">${anom ? 'ANOMALY' : 'NOMINAL'}</span></div>
        <div class="metrics"></div><div class="dim" style="font-size:9px;margin-top:4px">${DEVICES[d].topic}</div>`;
      const mb = card.querySelector('.metrics');
      DEVICES[d].metrics.forEach(m => {
        const v = sim.values[m]; const n = norms[d][m];
        const dev = Math.abs(v - n) / (n || 1);
        const hot = dev > 0.5; const warn = dev > 0.25;
        const fill = normVal(d, m, v);
        mb.innerHTML += `<div class="metric-row"><span class="metric-name">${m}</span>
          <div class="metric-bar"><div class="fill ${hot ? 'hot' : warn ? 'warn' : ''}" style="width:${Math.min(100, fill * 100)}%"></div></div>
          <span class="metric-val ${hot ? 'hot' : warn ? 'warn' : ''}">${v.toFixed(1)}<span class="dim" style="font-size:9px">${DEVICES[d].units[DEVICES[d].metrics.indexOf(m)]}</span></span></div>`;
      });
      g.appendChild(card);
    });
  }
  function anomEvidence(d) {
    return DEVICES[d].metrics.some(m => driftRigs[d][m] && driftRigs[d][m].width < driftRigs[d][m].minWindow && driftRigs[d][m].window.length);
  }

  /* ------------- process each telemetry tick through edge intelligence ------------- */
  function onTelemetry(msg) {
    const d = msg.device;
    Object.entries(msg.values).forEach(([m, v]) => {
      const inv = driftRigs[d][m], kal = kalmanRigs[d][m];
      const drifted = inv.add(normVal(d, m, v));
      kal.update(normVal(d, m, v));
      const key = d + '.' + m;
      const dh = driftHistory[key]; if (!dh) return;
      if (dh[0].length > 70) { dh[0].shift(); dh[1].shift(); }
      dh[0].push(state.broker.tickCount);
      dh[1].push(drifted ? 1 : 0);   // ADWIN changing-point
      const kh = kalmanHistory[key];
      if (kh[0].length > 70) { kh[0].shift(); kh[1].shift(); }
      kh[0].push(state.broker.tickCount); kh[1].push(kal.x);
      causalTracker.push(key, normVal(d, m, v));
    });
    updateDriftViewer();
    updateKalmanViewer();
  }




  function computeCausal() {
    causalNodes = [];
    const pairs = [];
    const names = Object.keys(DEVICES).flatMap(d => DEVICES[d].metrics.map(m => d + '.' + m));
    for (let i = 0; i < names.length; i++) {
      for (let j = 0; j < i; j++) {
        const s = causalTracker.causalScore(names[i], names[j]);
        pairs.push({ a: names[i], b: names[j], score: s });
      }
    }
    pairs.sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
    const top = pairs.slice(0, 5).filter(p => Math.abs(p.score) > 0.08);
    top.forEach(p => causalNodes.push({ from: p.a, to: p.b, weight: Math.abs(p.score), lead: p.a }));
    renderCausalTable();
    drawCausalGraph();
  }

  function renderCausalTable() {
    const el = $('#causalTable');
    if (!causalNodes.length) { el.innerHTML = '<div class="dim">Accumulating telemetry to infer causal edges…</div>'; return; }
    el.innerHTML = '<table class="dt"><tr><th>Edge</th><th>Strength</th><th>Lead</th></tr>' +
      causalNodes.map((e, i) => `<tr><td>${e.from.split('.').join(':')} → ${e.to.split('.').join(':')}</td><td class="cyan">${e.weight.toFixed(2)}</td><td><span class="${e.weight > 0.3 ? 'green' : 'amber'}">${e.lead.split('.').join(':')}</span></td></tr>`).join('') +
      '</table>';
  }

  function drawCausalGraph() {
    const cv = $('#causalCanvas'); const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (!causalNodes.length) {
      ctx.fillStyle = '#6b82a0'; ctx.font = '12px monospace';
      ctx.fillText('Building causal graph from live lag-correlation…', 20, 30);
      return;
    }
    // place nodes in a ring
    const names = causalNodes.flatMap(e => [e.from, e.to]);
    const unique = Array.from(new Set(names)).slice(0, 8);
    const cx = cv.width / 2, cy = cv.height / 2, R = Math.min(cx, cy) - 40;
    const pos = {};
    unique.forEach((n, i) => {
      const ang = -Math.PI / 2 + (i / unique.length) * Math.PI * 2;
      pos[n] = { x: cx + R * Math.cos(ang), y: cy + R * Math.sin(ang) };
    });
    // edges
    causalNodes.forEach(e => {
      const a = pos[e.from], b = pos[e.to];
      if (!a || !b) return;
      ctx.strokeStyle = e.weight > 0.3 ? 'rgba(34,211,238,0.9)' : 'rgba(251,191,36,0.7)';
      ctx.lineWidth = 1 + e.weight * 4;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    });
    // nodes
    unique.forEach(n => {
      const p = pos[n];
      ctx.fillStyle = '#0f1a2b'; ctx.strokeStyle = '#22d3ee'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(p.x, p.y, 14, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = '9px monospace'; ctx.textAlign = 'center';
      ctx.fillText(n.split('.').join(':').replace('MOTOR_01:tem', 'MOT:' ) || n, p.x, p.y + 3);
    });
  }

  /* ------------- KPI ------------- */
  function updateKpi(delta) { Object.assign(state.kpi, delta); renderKpi(); }
  function renderKpi() {
    $('#kpis').innerHTML = `<div class="kpi"><div class="lbl">ACTIVE WORK ORDERS</div><div class="val">${state.kpi.wos}</div></div>
      <div class="kpi"><div class="lbl">PENDING APPROVALS</div><div class="val ${state.kpi.approvals ? 'warn' : ''}">${state.kpi.approvals}</div></div>
      <div class="kpi"><div class="lbl">ANOMALIES NOW</div><div class="val ${state.kpi.anomalies ? 'hot' : ''}">${state.kpi.anomalies}</div></div>
      <div class="kpi"><div class="lbl">LEARNED RUNBOOKS</div><div class="val">${state.kpi.learning}</div></div>`;
  }

  /* ------------- approvals / wo / runbook ------------- */
  const approveId = (id, decision) => {
    const ap = state.tools.approvals.find(a => a.id === id);
    if (!ap) return;
    ap.status = decision;
    traceRow('APPROVE', 'Human', `${id} → ${decision}`);
    if (decision !== 'DENY') {
      const device = (ap.ref || '/').split('/')[0];
      const m = ap.title.match(/Approve (.+) on (.+)/);
      const action = m ? m[1] : 'approved action';
      // HITL gate passed → Factory Action executes the tool call (idempotent) + read-back verify
      const wo = state.tools.createWorkOrder({ device, content: `HITL-approved execution: ${action}`, priority: 'HIGH', sourceTask: 'approval:' + id });
      state.tools.verifyWorkOrder(wo.id);
      const sim = state.broker && state.broker.sims[device];
      if (sim) sim.clearAllFaults();   // mitigation applied to the fabric
      state.tools.notify({ channel: 'sms', to: 'shift-lead', message: `${action} executed on ${device} after human approval`, ref: id });
      traceRow('TOOL', 'Factory Action', `Post-approval commit → ${wo.id} (${action} on ${device}); mitigation applied.`);
      emitSyslog(`✅ Human decision ${decision} → executed "${action}" on ${device}`);
      updateKpi({ wos: state.tools.workOrders.length });
    } else {
      traceRow('AGENT', 'Safety', 'Human DENIED the action → fallback to monitoring-only policy.');
      emitSyslog(`✋ Human denied ${id}; system switched to monitoring-only.`);
    }
    renderApprovals(); renderWO();
  };
  function renderApprovals() {
    const pending = state.tools.approvals.filter(a => a.status === 'PENDING');
    state.kpi.approvals = pending.length; renderKpi();
    const el = $('#approvalList');
    if (!pending.length) { el.innerHTML = '<div class="dim">No pending approvals</div>'; return; }
    el.innerHTML = pending.map(a => `<div class="appr-item"><div class="title-sm">${a.title}</div>
      <div>${a.detail}</div>
      <div class="btns">${a.options.map(o => `<button class="btn small ${o.includes('DENY') ? 'danger' : 'primary'}" onclick="window.__aprove('${a.id}','${o}')">${o}</button>`).join('')}</div></div>`).join('');
  }
  window.__aprove = approveId;

  function renderWO() {
    const el = $('#woList');
    if (!state.tools.workOrders.length) { el.innerHTML = '<div class="dim">No work orders yet — run a task</div>'; return; }
    el.innerHTML = state.tools.workOrders.slice().reverse().map(w =>
      `<div class="wo-item"><span class="title-sm">${w.id}</span> · ${w.device} · <span class="${w.status === 'VERIFIED' ? 'green' : 'amber'}">${w.status}</span>
      <div class="dim">${w.content}</div>
      <div class="dim" style="font-size:9px">${new Date(w.createdAt).toLocaleTimeString()} · ${w.verification ? '✓ verified' : 'pending verify'}</div></div>`).join('');
  }

  function renderRunbooks() {
    const list = getRunbooks();
    const el = $('#runbookList');
    if (!list.length) { el.innerHTML = '<div class="dim">Wiki empty — runs distill knowledge here</div>'; return; }
    el.innerHTML = list.slice().reverse().map(r =>
      `<div class="rb-item"><span class="title-sm">${r.id}</span> <span class="violet">×${r.occurrences}</span>
      <div class="dim">${r.device} · ${r.content}</div></div>`).join('');
  }

  /* ------------- Agent Fleet tab: live orchestration showcase ------------- */
  function trackFleet(ev) {
    switch (ev.type) {
      case 'agent': {
        const a = fleet.agents[ev.agent] || (fleet.agents[ev.agent] = { msgs: 0, last: '', kind: '', activeUntil: 0 });
        a.msgs++; a.last = ev.detail; a.kind = ev.kind; a.activeUntil = Date.now() + 1500;
        if (ev.kind === 'decision') fleet.decisions++;
        break;
      }
      case 'tool':
        fleet.toolCalls++; fleet.toolActiveUntil = Date.now() + 1500;
        if (ev.action === 'TW_DEDUP') fleet.dedup++;
        if (ev.action === 'TOOL_CREATE_WORKORDER') fleet.woCreate++;
        if (ev.action === 'TOOL_REQUEST_APPROVAL') fleet.apprReq++;
        break;
      case 'verification': fleet.verifs++; break;
      case 'task_start': fleet.tasks++; break;
      case 'task_end':
        if (pendingRunbookHit && ev.verdict === 'VERIFIED') {
          pushRunbookLog('apply', `✅ SOP "${pendingRunbookHit}" thực thi thành công → ${ev.taskId} VERIFIED`);
        }
        pendingRunbookHit = null;
        break;
      case 'info': {
        const hit = /Runbook hit \(([^)]+)\)/.exec(ev.detail || '');
        if (hit) {
          const rb = getRunbooks().find(r => r.id === hit[1]);
          if (rb) rb.occurrences++;   // lượt dùng được ghi nhận → knowledge compounding
          pendingRunbookHit = hit[1];
          pushRunbookLog('hit', `⚡ Runbook ${hit[1]} matched → áp SOP đã chưng cất (bỏ qua suy luận lại)`);
        }
        const dis = /Distilled new runbook entry for (\S+)/.exec(ev.detail || '');
        if (dis) pushRunbookLog('distill', `🧠 Distilled tri thức mới cho ${dis[1]} → wiki cập nhật`);
        break;
      }
    }
    renderFleetSoon();
  }
  function pushRunbookLog(kind, text) {
    runbookLog.push({ ts: new Date().toLocaleTimeString('en-GB'), kind, text });
    while (runbookLog.length > 40) runbookLog.shift();
    renderRunbookLogSoon();
  }
  let fleetDirty = false;
  function renderFleetSoon() {
    if (fleetDirty) return;
    fleetDirty = true;
    setTimeout(() => { fleetDirty = false; renderAgentBoard(); renderFleetStats(); }, 80);
  }
  let rbLogDirty = false;
  function renderRunbookLogSoon() {
    if (rbLogDirty) return;
    rbLogDirty = true;
    setTimeout(() => { rbLogDirty = false; renderRunbookBoard(); renderRunbookLog(); renderRunbooks(); }, 80);
  }

  function fleetViewVisible() { const v = $('#view-fleet'); return v && !v.classList.contains('hidden'); }

  function agentCard(name) {
    const a = fleet.agents[name] || { msgs: 0, last: 'Chưa hoạt động — chờ task…', kind: '', activeUntil: 0 };
    const live = a.activeUntil > Date.now();
    return `<div class="agent-card ${live ? 'live' : ''}">
      <div class="ac-head"><span class="ac-name">${name}</span><span class="ac-led"></span></div>
      <div class="ac-role">${AGENT_ROLES[name] || 'agent'}</div>
      <div class="ac-msg">${esc(a.last)}</div>
      <div class="ac-count">msgs <b>${a.msgs}</b>${a.kind === 'decision' ? ' · 🧠 decision' : ''}</div>
    </div>`;
  }
  function renderAgentBoard() {
    const el = $('#agentBoard'); if (!el) return;
    let html = '';
    FLEET_PIPELINE.forEach((stage, i) => {
      if (i > 0) html += '<div class="fleet-arrow">➜</div>';
      html += `<div class="fleet-stage">${stage.map(agentCard).join('')}</div>`;
    });
    // Tool/API gateway card (biểu tượng của ToolLayer)
    const toolLive = fleet.toolActiveUntil > Date.now();
    html += '<div class="fleet-arrow">➜</div>';
    html += `<div class="fleet-stage"><div class="agent-card ${toolLive ? 'live' : ''}" style="border-color:#2b4a6b">
      <div class="ac-head"><span class="ac-name">Tool/API Gateway</span><span class="ac-led"></span></div>
      <div class="ac-role">idempotent · verify · timeout-safe</div>
      <div class="ac-msg">POST /ops/workorders · dedup ×${fleet.dedup} · approval requests ×${fleet.apprReq}</div>
      <div class="ac-count">calls <b>${fleet.toolCalls}</b> · verified <b>${fleet.verifs}</b></div>
    </div></div>`;
    el.innerHTML = html;
  }
  function renderFleetStats() {
    const el = $('#fleetStats'); if (!el) return;
    const chips = [
      ['TASKS RUN', fleet.tasks, ''],
      ['AGENT DECISIONS', fleet.decisions, 'v'],
      ['TOOL CALLS', fleet.toolCalls, ''],
      ['IDEMPOTENT DEDUPS', fleet.dedup, 'a'],
      ['READ-BACK VERIFIED', fleet.verifs, 'g'],
      ['APPROVAL GATES', fleet.apprReq, 'a'],
      ['RUNBOOK ENTRIES', getRunbooks().length, 'v'],
    ];
    el.innerHTML = chips.map(([l, n, c]) => `<div class="fleet-chip ${c}"><span class="n">${n}</span>${l}</div>`).join('');
  }
  function renderRunbookBoard() {
    const el = $('#runbookBoard'); if (!el) return;
    const list = getRunbooks();
    const maxOcc = Math.max(1, ...list.map(r => r.occurrences));
    el.innerHTML = list.slice().reverse().map(r => `<div class="rb-card">
      <div class="rb-head"><span class="rb-id">${r.id}</span><span class="rb-occ">×${r.occurrences} lần dùng</span></div>
      <div class="rb-meta">${r.device}${r.taskType ? ' · ' + r.taskType : ''}${r.created ? ' · distilled ' + new Date(r.created).toLocaleTimeString('en-GB') : ' · seed tri thức ban đầu'}</div>
      <div class="rb-content">${esc(r.content)}</div>
      <div class="rb-bar"><div class="f" style="width:${Math.min(100, r.occurrences / maxOcc * 100)}%"></div></div>
    </div>`).join('');
    state.kpi.learning = list.length;
  }
  function renderRunbookLog() {
    const el = $('#runbookLogView'); if (!el) return;
    if (!runbookLog.length) { el.innerHTML = '<div class="dim">Chưa có sự kiện tri thức — chạy scenario để thấy hit / distill…</div>'; return; }
    el.innerHTML = runbookLog.slice().reverse().map(l =>
      `<div class="rl ${l.kind}"><span class="t">${l.ts}</span><span>${esc(l.text)}</span></div>`).join('');
  }

  /* ------------- twin / objective ------------- */
  function syncObjectiveFromTrace(ev) {
    const ctx = ev;
    // We stored candidates on window for the last planner decision
    if (!window.__lastCandidates) return;
    renderObjective(window.__lastCandidates);
  }
  function renderObjective(cands) {
    if (!cands) return;
    state.twinCandidates = cands;
    const el = $('#objectiveTable');
    el.innerHTML = '<table class="dt"><tr><th>Action</th><th>Score</th><th>Pick</th></tr>' +
      cands.slice().sort((a, b) => b.score - a.score).map((c, i) =>
        `<tr class="${i === 0 ? 'winner' : ''}"><td>${c.action}</td><td>${c.score.toFixed(2)}</td><td>${i === 0 ? '✓' : ''}</td></tr>`).join('') + '</table>';
    drawTwin(cands);
  }
  function drawTwin(cands) {
    const cv = $('#twinChart'); const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    const hs = 260;
    if (!cands || !cands.length) return;
    // draw 3 scenario trajectories
    const colors = ['#22d3ee', '#a78bfa', '#fbbf24'];
    const top = cands.slice(0, 3);
    top.forEach((c, ci) => {
      const series = [];
      for (let s = 0; s < 6; s++) series.push(0.5 + (c.score - 0) * 0.1 + (Math.sin((s + ci) * 0.8 + c.score * 2) * 0.03));
      ctx.strokeStyle = colors[ci]; ctx.lineWidth = 2;
      ctx.beginPath();
      series.forEach((v, i) => {
        const x = 40 + i * (cv.width - 80) / 5;
        const y = hs - 20 - v * (hs - 50);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.fillStyle = colors[ci]; ctx.font = '10px monospace';
      ctx.fillText(`${c.action} (${c.score.toFixed(2)})`, 40, hs - 10 - ci * 14);
    });
  }

  /* ------------- drift + kalman viewers ------------- */
  let driftCtx, kalmanCtx;
  function initViewers() {
    driftCtx = $('#adwinCanvas').getContext('2d');
    kalmanCtx = $('#kalmanCanvas').getContext('2d');
  }
  function updateDriftViewer() {
    const cv = $('#adwinCanvas'); const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    const keys = Object.keys(driftHistory).slice(0, 6);
    const colors = ['#22d3ee', '#34d399', '#fbbf24', '#a78bfa', '#f87171', '#7dd3fc'];
    keys.forEach((k, ki) => {
      const [ticks, drift] = driftHistory[k];
      ctx.strokeStyle = colors[ki % 6]; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.9;
      ctx.beginPath();
      const maxX = ticks.length ? ticks[ticks.length - 1] : 1;
      ticks.forEach((t, i) => {
        const x = 30 + i * (cv.width - 40) / Math.max(60, ticks.length);
        const y = cv.height / 2 - (drift[i] === 1 ? 18 : 0);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = colors[ki % 6]; ctx.font = '10px monospace';
      ctx.fillText(k.split('.').join(':'), 30, 12 + ki * 13);
    });
  }
  function updateKalmanViewer() {
    const cv = $('#kalmanCanvas'); const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    // show MOTOR_01.current raw vs kalman
    const d = 'MOTOR_01', m = 'current';
    const raw = state.broker ? state.broker.history[d][m] : [];
    const key = d + '.' + m; const ks = kalmanHistory[key];
    const norm = RANGES[d][m];
    ctx.strokeStyle = '#f87171'; ctx.globalAlpha = 0.5; ctx.lineWidth = 1;
    ctx.beginPath();
    raw.forEach(([t, v], i) => { const x = 30 + i * (cv.width - 40) / 70; const y = cv.height - 20 - normVal(d, m, v) * (cv.height - 40); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
    ctx.globalAlpha = 1; ctx.strokeStyle = '#22d3ee'; ctx.lineWidth = 2;
    ctx.beginPath();
    // kalman estimate
    const est = ks[1] || [];
    est.forEach((v, i) => { const x = 30 + i * (cv.width - 40) / 70; const y = cv.height - 20 - v * (cv.height - 40); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.font = '10px monospace';
    ctx.fillText('— raw (noisy)  — Kalman estimate', 30, 12);
  }

  /* ------------- syslog ------------- */
  function emitSyslog(txt) { const el = $('#syslog'); el.insertAdjacentHTML('afterbegin', `<div>${txt}</div>`); while (el.children.length > 8) el.lastChild.remove(); }

  /* ------------- task lifecycle ------------- */
  function onTaskStart(ev) {
    traceRow('TASK', ev.device, `#${ev.taskId} :: "${ev.userText}"`);
    emitSyslog(`▶ Task ${ev.taskId} started on ${ev.device}`);
  }
  function onTaskEnd(ev) {
    traceRow('DONE', ev.device, `#${ev.taskId} ${ev.verdict}`);
    updateUiFromTools();
  }
  function updateUiFromTools() {
    state.kpi.wos = state.tools.workOrders.length;
    renderWO(); renderApprovals(); renderKpi();
  }

  /* ------------- fault injection (chaos) ------------- */
  function injectFault(device, kind, rate) {
    state.broker.sims[device].applyFault(kind, { rate });
    emitSyslog(`⚠ Injected fault ${kind} on ${device}`);
    updateAnomalyKpi();
  }
  function clearFaults() {
    Object.keys(DEVICES).forEach(d => state.broker.sims[d].clearAllFaults());
    emitSyslog('Cleared all faults');
    updateAnomalyKpi();
  }
  function updateAnomalyKpi() {
    const st = state.broker.getDeviceStatus();
    const n = Object.values(st).filter(v => v === 'ANOMALY').length;
    state.kpi.anomalies = n; renderKpi();
  }

  /* ------------- run a task through orchestrator ------------- */
  function runTask(device, type, text) {
    let txt = text || makePrompt(device, type);
    const p = state.orch.run(device, type, txt);
    if (p && p.then) p.then(ctx => maybeLLMReport(ctx)).catch(() => {});
    return txt;
  }

  /* ------------- Neuro-LLM: báo cáo RCA viết từ audit trail ------------- */
  function maybeLLMReport(ctx) {
    if (!ctx || typeof LLM === 'undefined' || !LLM.available()) return;
    const box = $('#reportBox');
    box.classList.remove('dim');
    box.textContent = `🧠 ${LLM.MODEL} đang viết báo cáo từ audit trail ${ctx.taskId}…`;
    const payload = {
      taskId: ctx.taskId, device: ctx.device, taskType: ctx.taskType, userText: ctx.userText,
      runbookHit: !!ctx.runbookHit,
      telemetry: (ctx.anomalyMap || []).map(a => `${a.metric}=${a.value} (${a.status})`),
      safety: ctx.safety ? { verdict: ctx.safety.verdict, explain: ctx.safety.explain } : null,
      production: ctx.prodImpact ? ctx.prodImpact.note : null,
      candidates: (ctx.candidates || []).map(c => `${c.action}: ${Number(c.score).toFixed(2)}`),
      chosenAction: ctx.chosen ? ctx.chosen.action : (ctx.runbookHit ? 'runbook SOP' : null),
      workOrder: ctx.workOrderId || null,
      verification: ctx.verification && ctx.verification.ok ? 'VERIFIED' : 'FAILED',
    };
    LLM.incidentReport(payload)
      .then(txt => {
        box.textContent = txt;
        traceRow('AGENT', 'Neuro-LLM', `🧾 Incident report ${ctx.taskId} đã sinh từ audit trail (${txt.length} ký tự).`);
        emitSyslog('🧾 AI Incident Report mới — xem panel Decision & Approval Gate.');
      })
      .catch(e => {
        box.textContent = `⚠ LLM report lỗi (${e.message}) — audit trail vẫn đầy đủ trong trace.`;
      });
  }

  /* ------------- Neuro-LLM chip (config key) ------------- */
  function updateLLMChip() {
    const on = typeof LLM !== 'undefined' && LLM.available();
    const st = $('#llmState'); if (!st) return;
    st.textContent = on ? LLM.MODEL.split('/').pop() : 'SYMBOLIC-ONLY';
    const dot = $('#llmDot');
    if (dot) { dot.classList.toggle('red', !on); if (on) dot.classList.add('green'); }
  }
  function makePrompt(device, type) {
    const start = DEVICES[device].type;
    if (type === 'inspection') return `Hãy chuẩn bị kế hoạch kiểm tra ${device} trước ca sản xuất tiếp theo.`;
    if (type === 'conflict') return `Dữ liệu ${device} đang thay đổi trong khi có đơn hàng gấp. Hãy đánh giá và đề xuất phương án vận hành.`;
    if (type === 'timeout') return `Hãy tạo công việc kiểm tra ${device} và xử lý an toàn nếu dữ liệu hoặc Tool không phản hồi như mong đợi.`;
    return `Hãy phối hợp các agent xử lý tình huống trên ${device}.`;
  }

  /* ------------- tabs ------------- */
  function bindTabs() {
    $$('.tab').forEach(t => t.addEventListener('click', () => {
      $$('.tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      $$('.view').forEach(v => v.classList.add('hidden'));
      $('#view-' + t.dataset.view).classList.remove('hidden');
    }));
  }

  /* ------------- boot ------------- */
  window.addEventListener('DOMContentLoaded', () => {
    initViewers();
    state.tools = new ToolLayer(emitter);
    state.broker = new SimBroker(() => {
      $('#mqttState').textContent = 'CONNECTED';
      $('#mqttChip .dot.red').classList.remove('red'); $('#mqttChip .dot').classList.add('green');
    });
    state.orch = new Orchestrator(state.tools, state.broker, emitter);
    window.__orch = state.orch;

    wireCandidateCapture();

    // subscribe to live telemetry topics -> edge intelligence pipeline
    Object.keys(DEVICES).forEach(id => {
      state.broker.on(DEVICES[id].topic, onTelemetry);
    });
    state.broker.connect();
    setInterval(() => renderDeviceGrid(), 400);
    setInterval(() => computeCausal(), 1200);
    setInterval(() => updateAnomalyKpi(), 3000);
    setInterval(() => { if (fleetViewVisible()) renderAgentBoard(); }, 700); // fade live LEDs

    // wire task launcher
    $('#taskSubmit').addEventListener('click', async () => {
      const v = $('#taskInput').value.trim();
      if (!v) return;
      // Neuro-LLM parse yêu cầu ngôn ngữ tự nhiên (fallback: keyword symbolic)
      if (typeof LLM !== 'undefined' && LLM.available()) {
        emitSyslog('🧠 Neuro-LLM đang phân tích yêu cầu vận hành...');
        try {
          const j = await LLM.parseTask(v, Object.keys(DEVICES));
          if (j) {
            traceRow('AGENT', 'Neuro-LLM', `parse → device=${j.device}, taskType=${j.taskType}${j.explain ? ' · ' + j.explain : ''}`);
            runTask(j.device, j.taskType, v);
            return;
          }
          emitSyslog('⚠ LLM parse không hợp lệ → fallback symbolic parser.');
        } catch (e) { emitSyslog('⚠ LLM lỗi (' + e.message + ') → fallback symbolic parser.'); }
      }
      // symbolic keyword fallback
      const dev = (Object.keys(DEVICES).find(d => v.toUpperCase().includes(d)) || 'MOTOR_01');
      const type = v.toLowerCase().includes('kiểm tra') ? 'inspection' : v.toLowerCase().includes('gas') || v.toLowerCase().includes('đơn hàng') ? 'conflict' : 'inspection';
      runTask(dev, type, v);
    });
    $$('.scenario').forEach(b => b.addEventListener('click', () => {
      const d = b.dataset.device, t = b.dataset.type;
      if (t === 'conflict') injectFault('GAS_01', 'gas_false', 55);
      if (t === 'inspection') injectFault('MOTOR_01', 'overheat', 5);
      if (t === 'timeout') { state.tools.setToolTimeout(true); injectFault('LINE_01', 'voltage_drop', 30); }
      runTask(d, t);
    }));
    $('#panicBtn').addEventListener('click', () => { clearFaults(); emitSyslog('⏻ E-STOP: all faults cleared, requesting maintenance'); state.tools.createIncident({ device: 'LINE_01', summary: 'Emergency stop invoked by operator', severity: 'HIGH' }); updateUiFromTools(); });

    // Neuro-LLM chip: click để dán / đổi OpenRouter key
    const llmChip = $('#llmChip');
    if (llmChip) llmChip.addEventListener('click', () => {
      const cur = (typeof LLM !== 'undefined') ? LLM.getKey() : '';
      const v = window.prompt('OpenRouter API key (bỏ trống để chạy SYMBOLIC-ONLY):', cur);
      if (v === null) return;
      LLM.setKey(v.trim());
      updateLLMChip();
      if (!v.trim()) { emitSyslog('🤖 Neuro-LLM tắt — hệ thống chạy symbolic-only.'); return; }
      emitSyslog('🧠 Đang kiểm tra Neuro-LLM link...');
      LLM.ping().then(ok => {
        emitSyslog(ok ? `✅ Neuro-LLM ONLINE (${LLM.MODEL})` : '⚠ Key không hoạt động / mất mạng — vẫn chạy symbolic bình thường.');
        updateLLMChip();
      });
    });

    bindTabs();
    renderKpi(); renderWO(); renderRunbooks();
    renderFleetStats(); renderAgentBoard(); renderRunbookBoard(); renderRunbookLog();
    updateLLMChip();
    emitSyslog('System ready. Click a scenario or type a natural-language ops request.');
  });

  // capture planner decision candidates for objective viewer
  function wireCandidateCapture() {
    const orch = state.orch;
    const realEmit = orch._emit.bind(orch);
    orch._emit = (ev) => {
      if (ev && ev.type === 'agent' && ev.kind === 'decision' && ev.agent === 'AI Planner') {
        // fetch chosen candidates from a stash the planner writes to window
        window.__lastCandidates = window.__plannerStash;
      }
      realEmit(ev);
    };
    // patch planner run to stash candidates
    const PlannerRun = state.orch.agents.planner.run.bind(state.orch.agents.planner);
    state.orch.agents.planner.run = async (ctx) => {
      const r = await PlannerRun(ctx);
      window.__plannerStash = ctx.candidates || [];
      setTimeout(() => { renderObjective(ctx.candidates); }, 60);
      return r;
    };
    // Also capture chosen via action verification
    const ActionRun = state.orch.agents.action.run.bind(state.orch.agents.action);
    state.orch.agents.action.run = async (ctx) => { const r = await ActionRun(ctx); renderWO(); renderApprovals(); return r; };
  }

})();