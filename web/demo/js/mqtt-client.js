/* =============================================================================
   mqtt-client.js — MiniMQTT: MQTT 3.1.1 client tối giản chạy trên WebSocket.
   Tự implement wire protocol (không thư viện ngoài) để demo giữ được tính
   self-contained: CONNECT (username/password) · SUBSCRIBE · PUBLISH (QoS0,
   PUBACK cho QoS1 nhận được) · PINGREQ keep-alive · parser buffered varint.
   Dùng cho REALTIME mode: nối broker BTC qua wss://host:443/mqtt.
============================================================================= */
(function () {
  'use strict';
  const enc = new TextEncoder(), dec = new TextDecoder();

  function strBytes(s) {
    const b = enc.encode(String(s));
    const out = new Uint8Array(b.length + 2);
    out[0] = (b.length >> 8) & 255; out[1] = b.length & 255;
    out.set(b, 2);
    return out;
  }
  function varint(n) {
    const out = [];
    do {
      let d = n % 128;
      n = Math.floor(n / 128);
      if (n > 0) d |= 0x80;
      out.push(d);
    } while (n > 0);
    return out;
  }
  function concat(arrs) {
    let len = 0; arrs.forEach(a => (len += a.length));
    const out = new Uint8Array(len);
    let o = 0; arrs.forEach(a => { out.set(a, o); o += a.length; });
    return out;
  }
  function packet(typeByte, body) {
    return concat([new Uint8Array([typeByte]), new Uint8Array(varint(body.length)), body]);
  }

  class MiniMQTT {
    /** opts: username, password, clientId, keepalive(s), onConnect, onSuback,
     *        onMessage(topic,payload), onError(msg), onClose(evt) */
    constructor(url, opts = {}) {
      this.url = url; this.opts = opts;
      this.keepalive = opts.keepalive || 60;
      this.ws = null; this.buf = new Uint8Array(0);
      this.pid = 0; this.pingTimer = null; this.connackTimer = null;
      this.connected = false; this.closedByUser = false;
    }

    connect() {
      this.closedByUser = false;
      // Broker EMQX của BTC bắt buộc Sec-WebSocket-Protocol: mqtt — không có
      // subprotocol này, broker từ chối handshake (close 1006) dù credentials đúng.
      const ws = new WebSocket(this.url, ['mqtt']);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.onopen = () => this._sendConnect();
      ws.onmessage = e => this._onData(new Uint8Array(e.data));
      ws.onerror = () => { if (this.opts.onError) this.opts.onError('websocket error'); };
      ws.onclose = e => {
        this._teardown();
        if (!this.closedByUser && this.opts.onClose) this.opts.onClose(e);
      };
      this.connackTimer = setTimeout(() => {
        if (!this.connected) this._fail('CONNACK timeout (10s)');
      }, 10000);
    }

    disconnect() {
      this.closedByUser = true;
      this._teardown();
      try {
        if (this.ws) {
          if (this.ws.readyState === 1) this.ws.send(new Uint8Array([0xE0, 0])); // DISCONNECT
          this.ws.close();
        }
      } catch (e) { /* ignore */ }
    }

    subscribe(topic) {
      this.pid = ((this.pid + 1) & 0xffff) || 1;
      const body = concat([
        new Uint8Array([this.pid >> 8, this.pid & 255]),
        strBytes(topic),
        new Uint8Array([0]), // requested QoS 0
      ]);
      this._send(packet(0x82, body));
    }

    publish(topic, text) {
      const body = concat([strBytes(topic), enc.encode(String(text))]);
      this._send(packet(0x30, body)); // QoS 0
    }

    /* ---------------- internals ---------------- */
    _fail(msg) {
      try { if (this.ws) this.ws.close(); } catch (e) { /* ignore */ }
      if (this.opts.onError) this.opts.onError(msg);
    }
    _teardown() {
      this.connected = false;
      if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
      if (this.connackTimer) { clearTimeout(this.connackTimer); this.connackTimer = null; }
    }
    _send(bytes) {
      if (this.ws && this.ws.readyState === 1) this.ws.send(bytes);
    }
    _sendConnect() {
      const o = this.opts;
      let flags = 0x02; // clean session
      if (o.username) flags |= 0x80;
      if (o.password) flags |= 0x40;
      const body = concat([
        strBytes('MQTT'),
        new Uint8Array([0x04]),                         // protocol level 4 (MQTT 3.1.1)
        new Uint8Array([flags, (this.keepalive >> 8) & 255, this.keepalive & 255]),
        strBytes(o.clientId || ('aiops-' + Math.random().toString(36).slice(2, 10))),
        ...(o.username ? [strBytes(o.username)] : []),
        ...(o.password ? [strBytes(o.password)] : []),
      ]);
      this._send(packet(0x10, body));
    }
    _onData(chunk) {
      const merged = new Uint8Array(this.buf.length + chunk.length);
      merged.set(this.buf); merged.set(chunk, this.buf.length);
      this.buf = merged;
      for (;;) {
        if (this.buf.length < 2) return;
        const type = this.buf[0] >> 4;
        // remaining-length varint (max 4 bytes)
        let mult = 1, rem = 0, i = 1, bad = false;
        for (;;) {
          if (i >= this.buf.length) return;             // header chưa đủ — chờ thêm
          const b = this.buf[i];
          rem += (b & 0x7f) * mult;
          mult *= 128; i++;
          if ((b & 0x80) === 0) break;
          if (i > 4) { bad = true; break; }
        }
        if (bad) { this._fail('malformed remaining-length'); return; }
        const total = i + rem;
        if (this.buf.length < total) return;            // packet chưa đủ — chờ thêm
        const hdr = this.buf[0];
        const body = this.buf.subarray(i, total);
        this.buf = this.buf.subarray(total);
        this._dispatch(hdr, body);
      }
    }
    _dispatch(hdr, body) {
      const type = hdr >> 4;
      if (type === 2) {                                  // CONNACK
        const rc = body[1];
        if (rc === 0) {
          this.connected = true;
          if (this.connackTimer) { clearTimeout(this.connackTimer); this.connackTimer = null; }
          this.pingTimer = setInterval(() => this._send(new Uint8Array([0xC0, 0])),
            Math.max(5, this.keepalive / 2) * 1000);     // PINGREQ
          if (this.opts.onConnect) this.opts.onConnect();
        } else this._fail('CONNACK refused rc=' + rc);
      } else if (type === 3) {                           // PUBLISH (nhận)
        const qos = (hdr >> 1) & 3;                      // QoS nằm ở fixed header byte
        const tlen = (body[0] << 8) | body[1];           // topic length (2 byte đầu variable header)
        const topic = dec.decode(body.subarray(2, 2 + tlen));
        let off = 2 + tlen, pid = 0;
        if (qos > 0) { pid = (body[off] << 8) | body[off + 1]; off += 2; }
        const payload = dec.decode(body.subarray(off));
        if (qos === 1) this._send(concat([new Uint8Array([0x40, 2]), new Uint8Array([pid >> 8, pid & 255])])); // PUBACK
        if (this.opts.onMessage) this.opts.onMessage(topic, payload);
      } else if (type === 9) {                           // SUBACK
        if (this.opts.onSuback) this.opts.onSuback(body);
      }
      /* type 13 (PINGRESP): keep-alive ok, không cần xử lý */
    }
  }

  window.MiniMQTT = MiniMQTT;
})();
