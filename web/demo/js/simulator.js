/* =============================================================================
   simulator.js — Simulated Industrial IoT fabric (MQTT-style telemetry).
   Emulates the BTC MQTT broker emitting tick data for all 6 devices at ~4 Hz.
   Supports fault injection, gas leak, load events, and background drift so the
   agents have real signal to reason about.
============================================================================= */

const DEVICES = {
  MOTOR_01: { type: 'Motor (Conveyor 1)', units: ['A', 'mm/s', '°C'], metrics: ['current', 'vibration', 'temperature'], topic: 'factory/line1/motor01/telemetry' },
  LINE_01: { type: 'Main Line', units: ['V', 'A'], metrics: ['voltage', 'current'], topic: 'factory/line1/line01/telemetry' },
  CONVEYOR_01: { type: 'Conveyor 1', units: ['m/s', 'kg'], metrics: ['speed', 'load'], topic: 'factory/line1/conveyor01/telemetry' },
  PRESS_01: { type: 'Furnace Pressure', units: ['bar'], metrics: ['pressure'], topic: 'factory/line1/press01/telemetry' },
  GAS_01: { type: 'Workshop Gas', units: ['ppm'], metrics: ['gas'], topic: 'factory/line1/gas01/telemetry' },
  PROBE_01: { type: 'Furnace Probe', units: ['°C'], metrics: ['temperature'], topic: 'factory/line1/probe01/telemetry' },
};

class DeviceSim {
  constructor(id, cfg) {
    this.id = id;
    this.cfg = cfg;
    this.metrics = cfg.metrics;
    this.units = cfg.units;
    // baselines normal operating points
    this.norm = { MOTOR_01: { current: 45, vibration: 1.5, temperature: 55 },
      LINE_01: { voltage: 415, current: 120 },
      CONVEYOR_01: { speed: 1.2, load: 180 },
      PRESS_01: { pressure: 5.2 },
      GAS_01: { gas: 12 },
      PROBE_01: { temperature: 420 } };
    this.noise = { MOTOR_01: { current: 2.5, vibration: 0.15, temperature: 1.5 },
      LINE_01: { voltage: 4, current: 6 },
      CONVEYOR_01: { speed: 0.05, load: 12 },
      PRESS_01: { pressure: 0.2 },
      GAS_01: { gas: 1.2 },
      PROBE_01: { temperature: 8 } };
    this.values = this._alloc(this.norm[id]);
    this.faults = {};   // active fault actions
    this.t = 0;
  }

  _alloc(base) {
    const v = {};
    Object.keys(base).forEach(k => (v[k] = base[k]));
    return v;
  }

  applyFault(kind, params = {}) { this.faults[kind] = { ...params, kind }; }
  clearFault(name) { delete this.faults[name]; }
  clearAllFaults() { this.faults = {}; }

  // update once (per tick)
  step() {
    this.t++;
    const fault = Object.values(this.faults)[0]; // simple: single active fault
    const prev = { ...this.values };
    this.metrics.forEach((m) => {
      let base = this.norm[this.id][m];
      let n = this.noise[this.id][m];
      let val = base + (Math.random() * 2 - 1) * n;
      val = this._applyFaultEffect(m, fault, prev, val);

      // slow thermal coupling: if load high, temp creeps
      if (this.id === 'MOTOR_01' && m === 'temperature') {
        const current = this.values.current || base;
        val += (current - this.norm[this.id].current) * 0.25;
      }
      // keep values within sane bounds
      val = Math.max(0, val);
      this.values[m] = val;
      this.values[m + '_raw'] = val; // raw (noisy)
    });
  }

  _applyFaultEffect(m, fault, prev, cur) {
    if (!fault) return cur;
    switch (fault.kind) {
      case 'overheat':
        if (m === 'temperature') cur += (fault.rate || 6) * 1.4;
        if (m === 'vibration') cur += (fault.rate || 3) * 0.1;
        break;
      case 'vibration':
        if (m === 'vibration') cur += fault.rate || 0.8;
        break;
      case 'current_spike':
        if (m === 'current') cur += fault.rate || 30;
        break;
      case 'voltage_drop':
        if (m === 'voltage') cur = (this.norm[this.id].voltage || 0) - Math.max(5, fault.rate || 40);
        break;
      case 'pressure':
        if (m === 'pressure') cur += fault.rate || 1.5;
        break;
      case 'gas_false':
        if (m === 'gas') cur = fault.rate || 60;
        break;
      case 'gas_leak':
        if (m === 'gas') cur += fault.rate || 8;
        break;
      case 'overload':
        if (m === 'load') cur += fault.rate || 200;
        break;
    }
    return Math.max(0, cur);
  }

  snapshot() {
    const out = { device: this.id, ts: Date.now(), values: {} };
    this.metrics.forEach(m => (out.values[m] = round1(this.values[m])));
    return out;
  }
}

function round1(x) { return Math.round(x * 10) / 10; }

/* ---------------------------------------------------------------------------
   MQTT broker-like event emitter with subscription + telemetry ring buffer.
--------------------------------------------------------------------------- */
class SimBroker {
  constructor(mqttStatusCb) {
    this.subs = {};
    this.history = {};   // device -> { metric: [[t,val]] }
    this.sims = {};
    this.speedMs = 250; // tick interval
    this.mqttStatusCb = mqttStatusCb || (() => {});
    this.paused = false;
    this.connected = false;
    this.tickCount = 0;
    Object.keys(DEVICES).forEach(id => {
      this.sims[id] = new DeviceSim(id, DEVICES[id]);
      this.history[id] = {};
      DEVICES[id].metrics.forEach(m => { this.history[id][m] = []; });
    });
  }

  on(topic, cb) {
    if (!this.subs[topic]) this.subs[topic] = [];
    this.subs[topic].push(cb);
    return () => { this.subs[topic] = this.subs[topic].filter(f => f !== cb); };
  }

  publish(topic, payload) {
    (this.subs[topic] || []).forEach(cb => cb(payload));
  }

  connect() {
    this.connected = true;
    this.mqttStatusCb('connected');
    if (this._interval) clearInterval(this._interval);
    this._interval = setInterval(() => this.tick(), this.speedMs);
  }

  tick() {
    if (this.paused) return;
    this.tickCount++;
    const ts = Date.now();
    Object.values(this.sims).forEach(sim => {
      sim.step();
      const snap = sim.snapshot();
      const msg = { ...snap, tick: this.tickCount, broker: 'assets/edge-gateway' };
      this.publish(sim.cfg.topic, msg);
      // ring buffer for charts (keep last 60)
      sim.cfg.metrics.forEach(m => {
        const h = this.history[sim.id][m];
        h.push([ts, sim.values[m]]);
        if (h.length > 80) h.shift();
      });
    });
  }

  getDeviceFault(id) { return this.sims[id].faults; }
  getHistory(id) { return this.history[id]; }
  getDeviceStatus() {
    const st = {};
    Object.values(this.sims).forEach(sim => {
      st[sim.id] = Object.keys(sim.faults).length > 0 ? 'ANOMALY' : 'NORMAL';
    });
    return st;
  }

  setSpeed(ms) {
    this.speedMs = ms;
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = setInterval(() => this.tick(), this.speedMs);
    }
  }

  destroy() { if (this._interval) clearInterval(this._interval); }
}

window.DEVICES = DEVICES;
window.SimBroker = SimBroker;