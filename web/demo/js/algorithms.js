/* =============================================================================
   algorithms.js — Streaming AI algorithms (implemented real, no deps)
   ADWIN adaptive-window drift detection, Kalman filter, online lag-correlation
   causal scoring, what-if physics simulator, health score.
   Used by the Edge Intelligence layer of the demo.
============================================================================= */

/* ---------------------------------------------------------------------------
   ADWIN (Adaptive Window) drift detector
   Ref: Bifet & Gavaldà, "Learning from Time-Changing Data with Adaptive
   Windowing" (ICDM 2006).
   Maintains a window; if the mean of two sub-windows differs beyond a
   Hoeffding bound adjusted to window size/number-of-cuts, it shrinks the
   window from the oldest side and reports a drift.
--------------------------------------------------------------------------- */
class ADWIN {
  constructor(delta = 0.002, minWindow = 12) {
    this.delta = delta;
    this.minWindow = minWindow;
    this.window = [];
    this.maxWindow = 400;
    this.total = 0;
  }

  reset() {
    this.window = [];
    this.total = 0;
  }

  // Hoeffding bound for a cut: |mean0 - mean1| threshold
  _cutBound(n0, n1, n) {
    const m = 1.0 / n0 + 1.0 / n1;
    const logTerm = Math.log(4 * n / this.delta);
    return Math.sqrt(0.5 * m * 2 * logTerm);
  }

  add(value) {
    this.window.push(value);
    this.total += value;

    if (this.window.length > this.maxWindow) {
      this.total -= this.window.shift();
    }
    return this._detect();
  }

  _detect() {
    const n = this.window.length;
    if (n < 2 * this.minWindow) return false;

    let sumLeft = 0;
    for (let cut = this.minWindow; cut < n - this.minWindow; cut++) {
      sumLeft += this.window[cut - 1];
      const n0 = cut;
      const n1 = n - cut;
      const mean0 = sumLeft / n0;
      const mean1 = (this.total - sumLeft) / n1;
      const diff = Math.abs(mean0 - mean1);
      const bound = this._cutBound(n0, n1, n);
      if (diff > bound) {
        // shrink: drop the old side
        const removed = this.window.splice(0, cut);
        removed.forEach((v) => (this.total -= v));
        return true;
      }
    }
    return false;
  }

  get width() { return this.window.length; }
  get mean() {
    if (!this.window.length) return 0;
    return this.total / this.window.length;
  }
}

/* ---------------------------------------------------------------------------
   Kalman Filter (scalar) — fuses noisy sensor stream into a smoother estimate.
--------------------------------------------------------------------------- */
class Kalman {
  constructor(processVariance = 0.001, measurementVariance = 0.1) {
    this.q = processVariance; // process noise covariance
    this.r = measurementVariance; // measurement noise covariance
    this.x = 0; // estimate
    this.p = 1; // error covariance
    this.initialized = false;
  }

  reset() { this.initialized = false; this.x = 0; this.p = 1; }

  update(z) {
    if (!this.initialized) {
      this.x = z;
      this.p = 1;
      this.initialized = true;
      return this.x;
    }
    // predict
    const pPred = this.p + this.q;
    // update
    const kg = pPred / (pPred + this.r);
    this.x = this.x + kg * (z - this.x);
    this.p = (1 - kg) * pPred;
    return this.x;
  }
}

/* ---------------------------------------------------------------------------
   Online lag-correlation causal scorer.
   For two signals, computes cross-correlation across lags to infer the
   dominant direction & latency (a cheap, transparent Granger-style proxy).
--------------------------------------------------------------------------- */
class CausalTracker {
  constructor(maxLag = 10) {
    this.maxLag = maxLag;
    this.buffers = {};
  }

  push(name, value) {
    if (!this.buffers[name]) this.buffers[name] = [];
    const b = this.buffers[name];
    b.push(value);
    if (b.length > this.maxLag * 4) b.shift();
  }

  // Pearson between a and b when b is shifted by lag (b leads/follows)
  _corr(seriesA, seriesB, lagB) {
    const n = Math.min(seriesA.length, seriesB.length - lagB);
    if (lagB <= 0 || n < 3) return null;
    const ra = seriesA.slice(0, n);
    const rb = seriesB.slice(lagB, lagB + n);
    return pearson(ra, rb);
  }

  // Return {source, target, lag} that best explains A as caused by B lead.
  // dir: 'A_caused_by_B' means B's past correlates with A now.
  causalScore(a, b) {
    const sA = this.buffers[a] || [];
    const sB = this.buffers[b] || [];
    if (sA.length < this.maxLag + 3 || sB.length < this.maxLag + 3) return 0;

    let best = 0;
    // If B's past predicts A's present, direction A <- B
    for (let lag = 1; lag <= this.maxLag; lag++) {
      const c = this._corr(sA, sB, lag);
      if (c !== null && Math.abs(c) > Math.abs(best)) best = c;
    }
    return best; // magnitude = leading of B over A
  }

  // A lagged self-strength: B's past predicting B's present (persistence)
  selfStrength(a) {
    return this.causalScore(a, a);
  }
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n === 0) return 0;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i] - mx, y = ys[i] - my;
    num += x * y; dx += x * x; dy += y * y;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? 0 : num / den;
}

/* ---------------------------------------------------------------------------
   Physics-informed what-if simulator (mini digital twin).
   A first-order thermal/load model: for each device we keep a state vector S
   and apply candidate actions, simulating the next T steps. This is what the
   Planner uses to choose among candidate actions BEFORE sending any real tool
   call (our world-model layer).
--------------------------------------------------------------------------- */
class WhatIfSim {
  constructor() {
    // per-device behavioral parameters: how quickly each metric moves
    this.dev = {
      MOTOR_01: { k: [[0.9, 0.05, 0.03], [0.02, 0.93, 0.04], [0.04, 0.02, 0.95]], base: [45, 1.5, 55] },
      LINE_01:  { k: [[0.95, 0.04, 0], [0.03, 0.96, 0]], base: [230, 120] },
      CONVEYOR_01:{ k: [[0.92, 0.08],[0.03,0.97]], base: [1.2, 180] },
      PRESS_01: { k: [[0.96]], base: [5.2] },
      GAS_01:   { k: [[0.94]], base: [12] },
      PROBE_01: { k: [[0.97]], base: [420] },
    };
  }

  // simulate applying an action adjustment vector `delta` (per metric) for nSteps
  run(device, delta = [], nSteps = 6) {
    const d = this.dev[device];
    if (!d) return { x: [], series: [] };
    const dim = d.base.length;
    let state = d.base.slice();
    const series = [];
    for (let s = 0; s < nSteps; s++) {
      // apply action influence
      for (let i = 0; i < dim; i++) {
        if (delta[i]) state[i] = state[i] * (1 + delta[i] / 100);
      }
      // smooth toward equilibrium
      const next = new Array(dim);
      for (let i = 0; i < dim; i++) {
        let val = 0;
        for (let j = 0; j < dim; j++) val += d.k[i][j] * state[j];
        next[i] = val;
      }
      state = next;
      series.push(state.slice());
    }
    return { x: state, series };
  }
}

/* ---------------------------------------------------------------------------
   Objective-scoring function: convert candidate actions to a single score
   trading off Safety, Production, Energy and Cost.
   Decision = argmax over candidates.
--------------------------------------------------------------------------- */
function scoreDecision(metricChanges, weights = { safety: 0.4, production: 0.3, energy: 0.2, cost: 0.1 }) {
  // metricChanges is dict metricName -> normalized relief (-1..+1 benefit)
  const safety = metricChanges.hasOwnProperty('temperature') ? metricChanges.temperature : 0;
  const production = metricChanges.hasOwnProperty('load') ? metricChanges.load : 0;
  const energy = metricChanges.hasOwnProperty('current') ? metricChanges.current : 0;
  const cost = metricChanges.hasOwnProperty('pressure') ? metricChanges.pressure : 0;
  return (
    weights.safety * safety +
    weights.production * production +
    weights.energy * energy +
    weights.cost * cost
  );
}

/* Export to window */
window.ADWIN = ADWIN;
window.Kalman = Kalman;
window.CausalTracker = CausalTracker;
window.WhatIfSim = WhatIfSim;
window.scoreDecision = scoreDecision;
window.corr = pearson;