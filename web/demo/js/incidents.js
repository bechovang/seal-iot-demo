/* =============================================================================
   incidents.js — Incident Memory (Doc-Nodes) + windowId linking (Hướng A).

   Bộ nhớ sự cố có timestamp trên dashboard tĩnh. Mỗi bất thường được LLM/symbolic
   ghi thành một "doc node"; các node phát hiện + resolve cùng một sự cố nối qua
   windowId. Truy vấn theo khung thời gian trả lời "5p vừa rồi có gì".

   Schema node:
   {
     id, windowId, kind: 'detected'|'resolved',
     ts: Date.now(), tsISO,
     device, signal, severity: 'CRITICAL'|'WARNING'|'INFO',
     symptoms: [..], doc: string, telemetry: {..},
     resolved: null | {ok, action, workOrderId, ts},
     meta: { source: 'live'|'sim', scenario, fault }
   }

   Symbolic-first: luôn ghi node kể cả LLM offline; node có doc=null/placeholder vẫn
   đủ để truy vấn theo thời gian, LLM bổ sung sau.
============================================================================= */
(function () {
  'use strict';
  const KEY = 'aiops_incidents_v1';
  let INCIDENTS = [];
  let winSeq = 0;
  const RING = 500; // giữ tối đa số node trong localStorage (tránh tràn quota)

  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) INCIDENTS = arr;
    }
    // khôi phục seq window lớn nhất để không trùng windowId
    INCIDENTS.forEach(n => {
      const m = /(?:^|-)(\d+)$/.exec(String(n.windowId || ''));
      if (m) winSeq = Math.max(winSeq, parseInt(m[1], 10) || 0);
    });
  } catch (e) { /* không đọc được — khởi đầu trống */ }

  function persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify(INCIDENTS.slice(-RING)));
    } catch (e) { /* quota/denied: chỉ mất persist trong phiên */ }
    if (window.__incidentsChanged) try { window.__incidentsChanged(INCIDENTS); } catch (e) {}
  }

  const nowISO = () => new Date().toISOString();

  /* Node "phát hiện" — tức thì lúc bất thường xuất hiện. */
  function recordDetected(o) {
    const ts = Date.now();
    winSeq++;
    const node = {
      id: 'inc-' + ts + '-' + winSeq,
      windowId: 'w-' + winSeq,
      kind: 'detected',
      ts, tsISO: nowISO(),
      device: o.device, signal: o.signal || null,
      severity: o.severity || (o.critical ? 'CRITICAL' : 'WARNING'),
      symptoms: o.symptoms || [],
      doc: o.doc || null,
      telemetry: o.telemetry || {},
      resolved: null,
      meta: o.meta || {},
    };
    INCIDENTS.push(node);
    persist();
    return node;
  }

  /* Node "hoàn chỉnh" — sau khi xử lý xong; nhận một node detected (qua windowId
     hoặc id) để nối resolution. Nếu không thấy window thì tự tạo window mới. */
  function recordResolved(link, o) {
    const ts = Date.now();
    const anchor = link
      ? (INCIDENTS.find(n => n.windowId === link) ||
         INCIDENTS.find(n => n.id === link))
      : null;

    let node;
    if (anchor) {
      anchor.kind = anchor.kind === 'detected' ? 'incident' : anchor.kind;
      anchor.resolved = {
        ok: !!o.ok,
        action: o.action || null,
        workOrderId: o.workOrderId || null,
        rootCause: o.rootCause || null,
        doc: o.doc || anchor.doc,           // LLM tường trình hoàn chỉnh
        ts, tsISO: nowISO(),
      };
      node = anchor;
    } else {
      // không có node detect tương ứng (vd fault xảy ra trước khi load) → tạo mới
      node = {
        id: 'inc-' + ts + '-' + (++winSeq),
        windowId: 'w-' + winSeq,
        kind: 'incident',
        ts, tsISO: nowISO(),
        device: o.device, signal: o.signal || null,
        severity: o.severity || 'WARNING',
        symptoms: o.symptoms || [],
        doc: o.doc || null,
        telemetry: o.telemetry || {},
        resolved: {
          ok: !!o.ok, action: o.action || null,
          workOrderId: o.workOrderId || null, rootCause: o.rootCause || null,
          doc: o.doc,
        },
        meta: o.meta || {},
      };
      INCIDENTS.push(node);
    }
    persist();
    return node;
  }

  /* Truy vấn doc-nodes trong khung thời gian (ms). default: 300_000 = 5 phút. */
  function query(sinceMs, limit = 50) {
    const since = sinceMs == null ? Date.now() - 300000 : sinceMs;
    return INCIDENTS
      .filter(n => n.ts >= since)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit);
  }

  const all = () => INCIDENTS.slice();
  const reset = () => { INCIDENTS = []; persist(); };
  // lưu lại sau khi caller sửa in-place (vd LLM bổ sung doc vào node đã ghi)
  const touch = () => persist();

  window.IncidentMem = {
    recordDetected, recordResolved, query, all, reset, touch, persist,
    KEY, RING,
    // hook để main.js render lịch sử khi store đổi
    onChange(fn) { window.__incidentsChanged = fn; },
  };
})();