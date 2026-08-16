/* =============================================================================
   alarm-log.js — Anomaly / Alarm Log (vượt ngưỡng → báo động).

   Ghi lại mỗi lần một tín hiệu TELÊMETRY vượt ngưỡng cảnh báo (WARNING 25% /
   CRITICAL 50% so với baseline) thành một "alarm" có trạng thái ACTIVE,
   rồi đánh dấu RESOLVED khi tín hiệu trở về bình thường. Persist localStorage
   để qua lần refresh vẫn còn lịch sử.

   Schema alarm:
   { id, ts, tsISO, device, signal, value, normal, pct(%), severity, status:'ACTIVE'|'RESOLVED', source:'sim'|'live', resolvedTs }
============================================================================= */
(function () {
  'use strict';
  const KEY = 'aiops_alarms_v1';
  const RING = 300; // giữ tối đa số alarm trong localStorage (tránh tràn quota)
  let ALARMS = [];
  let seq = 0;

  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const a = JSON.parse(raw);
      if (Array.isArray(a)) ALARMS = a;
    }
    ALARMS.forEach(n => { const m = /-(\d+)$/.exec(String(n.id || '')); if (m) seq = Math.max(seq, parseInt(m[1], 10) || 0); });
  } catch (e) { /* không đọc được — khởi đầu trống */ }

  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(ALARMS.slice(-RING))); } catch (e) { /* quota/denied */ }
    if (window.__alarmsChanged) try { window.__alarmsChanged(ALARMS); } catch (e) {}
  }

  function record(o) {
    seq++;
    const ts = Date.now();
    const env = {
      id: 'al-' + ts + '-' + seq,
      ts, tsISO: new Date().toISOString(),
      device: o.device, signal: o.signal,
      value: o.value, normal: o.normal, pct: o.pct,
      severity: o.severity,            // CRITICAL | WARNING
      status: 'ACTIVE',                // ACTIVE -> RESOLVED
      source: o.source || 'sim',
      resolvedTs: null,
    };
    ALARMS.push(env);
    persist();
    return env;
  }

  // Đánh dấu alarm ACTIVE gần nhất của (device, signal) thành RESOLVED.
  function resolve(device, signal) {
    for (let i = ALARMS.length - 1; i >= 0; i--) {
      const a = ALARMS[i];
      if (a.device === device && a.signal === signal && a.status === 'ACTIVE') {
        a.status = 'RESOLVED';
        a.resolvedTs = Date.now();
        persist();
        return a;
      }
    }
    return null;
  }

  const all = () => ALARMS.slice();
  const active = () => ALARMS.filter(a => a.status === 'ACTIVE');
  const bySeverity = sev => ALARMS.filter(a => a.severity === sev);
  const reset = () => { ALARMS = []; persist(); };
  const touch = () => persist();
  const onChange = fn => { window.__alarmsChanged = fn; };

  window.AlarmLog = { record, resolve, all, active, bySeverity, reset, touch, onChange, KEY, RING };
})();