/* =============================================================================
   llm.js — Neuro-LLM link (OpenRouter) cho AI-Ops Commander.
   Vai trò: phần "NEURO" trong neuro-symbolic. LLM chỉ làm 2 việc giá trị cao:
     1) Phân tích yêu cầu vận hành ngôn ngữ tự nhiên → {device, taskType}
     2) Viết báo cáo RCA / quyết định bằng tiếng Việt từ audit trail
   Nguyên tắc an toàn:
     - LLM KHÔNG bao giờ được trực tiếp gọi tool / ra quyết định thực thi.
       Kết quả LLM luôn đi qua bộ kiểm tra biểu tượng (validate device,
       safety gate, approval HITL) — LLM sai thì hệ thống vẫn an toàn.
     - Không có key / mất mạng / lỗi → tự động rơi về chế độ SYMBOLIC-ONLY,
       toàn bộ demo vẫn chạy nguyên vẹn.
============================================================================= */
(function () {
  'use strict';

  const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
  const MODEL = (typeof window !== 'undefined' && window.__OPENROUTER_MODEL__) || 'deepseek/deepseek-v4-flash-0731';
  const LS_KEY = 'openrouter_api_key';

  const getKey = () => {
    try {
      return (localStorage.getItem(LS_KEY) || (typeof window !== 'undefined' && window.__OPENROUTER_KEY__) || '').trim();
    } catch (e) {
      return (typeof window !== 'undefined' && window.__OPENROUTER_KEY__) || '';
    }
  };
  const setKey = (k) => { try { localStorage.setItem(LS_KEY, k || ''); } catch (e) { /* private mode */ } };

  const available = () => !!getKey() && typeof fetch === 'function';

  /* ---------- core chat with timeout ---------- */
  async function chat(messages, opts = {}) {
    const key = getKey();
    if (!key) throw new Error('no-key');
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), opts.timeoutMs || 20000) : null;
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        signal: ctrl ? ctrl.signal : undefined,
        headers: {
          'Authorization': 'Bearer ' + key,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/bechovang/seal-iot-demo',
          'X-Title': 'AI-Ops Commander SEAL Demo',
        },
        body: JSON.stringify({
          model: MODEL,
          messages,
          temperature: opts.temperature ?? 0.4,
          max_tokens: opts.maxTokens ?? 700,
        }),
      });
      if (!res.ok) throw new Error('http-' + res.status);
      const data = await res.json();
      if (data.error) throw new Error(data.error.message || 'api-error');
      const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
      if (!text) throw new Error('empty-reply');
      return text.trim();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /* ---------- ping: kiểm tra key sống/chết ---------- */
  async function ping() {
    try {
      const out = await chat([{ role: 'user', content: 'Trả lời đúng 2 chữ: OK VN' }], { timeoutMs: 15000, maxTokens: 250 });
      return out.length > 0;
    } catch (e) { return false; }
  }

  /* ---------- 1) NL task parser → JSON (được validate lại bằng symbolic) ---------- */
  async function parseTask(userText, deviceIds) {
    const sys = `Bạn là bộ phân tích yêu cầu vận hành nhà máy. Từ câu của kỹ sư, chọn đúng 1 thiết bị và loại nhiệm vụ.
Thiết bị hợp lệ: ${deviceIds.join(', ')}.
taskType hợp lệ: inspection (kiểm tra/bảo trì), conflict (xung đột gas/an toàn vs đơn hàng), timeout (lỗi kết nối/tool), generic (khác).
Chỉ trả JSON: {"device":"...","taskType":"...","explain":"<1 câu tiếng Việt>"}`;
    const raw = await chat([
      { role: 'system', content: sys },
      { role: 'user', content: userText },
    ], { timeoutMs: 20000, maxTokens: 450, temperature: 0.1 });
    const m = /\{[\s\S]*\}/.exec(raw);
    if (!m) return null;
    try {
      const j = JSON.parse(m[0]);
      // symbolic guard: chỉ chấp nhận giá trị hợp lệ — LLM hallucinate thì fallback
      if (!deviceIds.includes(j.device)) return null;
      if (!['inspection', 'conflict', 'timeout', 'generic'].includes(j.taskType)) j.taskType = 'generic';
      return j;
    } catch (e) { return null; }
  }

  /* ---------- 2) báo cáo RCA / quyết định từ audit trail ---------- */
  async function incidentReport(payload) {
    const sys = `Bạn là chuyên gia vận hành nhà máy. Dựa trên audit trail JSON dưới đây, viết BÁO CÁO SỰ CỐ & QUYẾT ĐỊNH bằng tiếng Việt, tối đa 6 câu, giọng kỹ thuật súc tích, gồm: (1) hiện tượng, (2) nhận định nguyên nhân, (3) hành động được chọn và vì sao, (4) kết quả xác minh. Không bịa số liệu ngoài JSON. Không dùng markdown heading.`;
    const raw = await chat([
      { role: 'system', content: sys },
      { role: 'user', content: JSON.stringify(payload) },
    ], { timeoutMs: 30000, maxTokens: 900 });
    return raw;
  }

  /* ---------- 3) chưng cất SOP runbook từ audit trail (knowledge compounding + LLM) ---------- */
  async function distillSOP(payload) {
    const sys = `Bạn là kỹ sư độ tin cậy (SRE) nhà máy. Từ audit trail JSON của một ca xử lý THÀNH CÔNG, viết một SOP chuẩn (runbook) bằng tiếng Việt: tối đa 2 câu, giọng mệnh lệnh ("Giảm...", "Kiểm tra...", "Nếu... thì..."), để agent tái sử dụng cho sự cố tương tự. Chỉ trả về nội dung SOP, không tiêu đề, không giải thích.`;
    const raw = await chat([
      { role: 'system', content: sys },
      { role: 'user', content: JSON.stringify(payload) },
    ], { timeoutMs: 30000, maxTokens: 700 });
    return raw;
  }

  /* ---------- 4) Operator chat — hỏi đáp trạng thái nhà máy từ LIVE state ---------- */
  async function chatAssistant(question, liveState) {
    const sys = `Bạn là trợ lý AI vận hành nhà máy thông minh. Trả lời câu hỏi của kỹ sư bằng tiếng Việt, tối đa 4 câu, dựa CHỈ vào LIVE_STATE JSON và INCIDENT_LOG (danh sách doc-node sự cố có timestamp, đã lọc theo khung thời gian được hỏi). Nếu câu hỏi như "5 phút vừa rồi có gì" "gần đây bất thường gì": trả lời theo INCIDENT_LOG trong khoảng đó (nêu thời điểm, thiết bị, mức độ, doc ngắn gọn). Nếu dữ liệu không đủ, nói rõ. Không bịa số liệu.`;
    const raw = await chat([
      { role: 'system', content: sys },
      { role: 'user', content: `LIVE_STATE=${JSON.stringify(liveState)}\n\nCâu hỏi: ${question}` },
    ], { timeoutMs: 30000, maxTokens: 800 });
    return raw;
  }

  /* ---------- 4b) incidentFlash — doc-node NGẮN cảnh báo tức thì ---------- */
  async function incidentFlash(payload) {
    const sys = `Bạn là kỹ sư vận hành nhà máy. Viết TỐI ĐA 2 câu tiếng Việt mô tả cảnh báo vừa phát hiện: thiết bị/tín hiệu nào, đang bất thường thế nào, rủi ro gì, nên kiểm tra gì. Ngắn gọn, không bịa số liệu ngoài telemetry.`;
    const raw = await chat([
      { role: 'system', content: sys },
      { role: 'user', content: JSON.stringify(payload) },
    ], { timeoutMs: 15000, maxTokens: 250 });
    return raw;
  }


  /* ---------- 5) Causal hypothesis — giải thích đồ thị nhân quả ---------- */
  async function causalHypothesis(payload) {
    const sys = `Bạn là chuyên gia phân tích nguyên nhân gốc (RCA) trong nhà máy. Dựa trên các cạnh nhân quả (lag-correlation, strength 0..1, lead = tín hiệu dẫn) và telemetry JSON, viết GIẢ THUYẾT NHÂN QUẢ bằng tiếng Việt: tối đa 4 câu, chỉ ra chuỗi lan truyền khả dĩ nhất và khuyến nghị 1 hành động kiểm chứng. Không bịa số liệu ngoài JSON.`;
    const raw = await chat([
      { role: 'system', content: sys },
      { role: 'user', content: JSON.stringify(payload) },
    ], { timeoutMs: 30000, maxTokens: 1200 });
    return raw;
  }

  window.LLM = { available, getKey, setKey, ping, parseTask, incidentReport, distillSOP, chatAssistant, incidentFlash, causalHypothesis, MODEL };
})();
