# AI-OPS COMMANDER — Control-Room Demo (SEAL Hackathon 2026 · Track C: Smart Factory)

Bản demo **chạy được ngay, không cần server, không cần cài đặt** cho kiến trúc
**Neuro-Symbolic Multi-Agent** trong vận hành nhà máy: nhiều AI agent phối hợp qua
luồng MQTT giả lập, phát hiện trôi dạt dữ liệu bằng **ADWIN**, lọc nhiễu bằng
**Kalman**, suy luận **nhân quả (causal RCA)**, mô phỏng **What-If Digital Twin**,
gọi **Tool/API có idempotency + verify + timeout**, và **tích lũy tri thức runbook**.

---

## ▶ Chạy demo

```
Chỉ cần mở file  web/demo/index.html  bằng trình duyệt (Chrome/Edge).
```

Không cần build, không cần Python/Node, không fetch mạng cho phần lõi (mọi thuật toán
chạy nội tuyến). **Neuro-LLM** (OpenRouter) là phần tăng cường tuỳ chọn — cần mạng
và API key, nếu không có thì demo tự chạy chế độ **SYMBOLIC-ONLY** đầy đủ.
Nếu trình duyệt chặn fetch từ `file://`, serve qua HTTP (tuỳ chọn):

```bash
cd web/demo
python -m http.server 8000
# mở http://localhost:8000
```

Chờ ~3 giây để MQTT fabric kết nối và telemetry chảy vào (chip **MQTT CONNECTED**
chuyển xanh). Sau đó bấm các nút kịch bản.

---

## 🧠 Neuro-LLM (OpenRouter · deepseek-v4-flash)

Chip **Neuro-LLM** trên topbar cho biết trạng thái link LLM. Hai cách bật:

1. Copy `js/config.example.js` → `js/config.js`, điền key (file `config.js` đã gitignore), hoặc
2. Bấm chip **Neuro-LLM** trên topbar → dán key (lưu localStorage).

Khi ONLINE, LLM được dùng ở **đúng 2 điểm giá trị cao** (và chỉ 2 điểm đó):

- **Task launcher**: gõ yêu cầu tiếng Việt tự do, vd `"gas tăng mà đơn hàng gấp quá, tính sao?"`
  → LLM parse ra `{device: GAS_01, taskType: conflict}` + giải thích, hiện trên trace.
  Kết quả **luôn được validate lại bằng symbolic** (device phải hợp lệ) — LLM hallucinate thì fallback parser cũ.
- **AI Incident Report**: sau mỗi task, LLM đọc audit trail (telemetry, safety verdict,
  candidates + score, WO, verification) và viết **báo cáo RCA tiếng Việt** vào panel
  "🧾 AI Incident Report". Prompt cấm bịa số liệu ngoài JSON.

**Nguyên tắc thiết kế**: LLM không bao giờ được trực tiếp gọi tool hay ra quyết định
thực thi — mọi hành động vẫn đi qua safety gate + HITL approval. LLM là "neuro",
luật an toàn là "symbolic".

---

## 🎬 Kịch bản demo 3 phút (theo thứ tự)

### Mở đầu · Tab "🤖 Agent Fleet & Runbook" (default)
Tab mới mở ngay khi boot, show **toàn cảnh đàn agent vận hành**:
- **Pipeline 5 stage** với 7 agent + Tool/API Gateway: mỗi card **sáng LED xanh realtime**
  khi agent đang phát thông điệp, kèm message gần nhất và tổng số lượt hoạt động.
- Stage 3 (Maintenance / Production / Safety) chạy **song song** — nhìn thấy rõ khi chạy task.
- Dải KPI fleet: TASKS RUN · AGENT DECISIONS · TOOL CALLS · IDEMPOTENT DEDUPS · READ-BACK VERIFIED · APPROVAL GATES.
- Bên phải: **Runbook wiki chi tiết** (số lần dùng, thanh tích lũy, nội dung SOP) +
  **Knowledge ops log** ghi lại từng sự kiện `⚡ hit` → `✅ apply` → `🧠 distill`.

👉 Trong lúc chạy S1/S2/S3 bên dưới, liếc tab này để thấy agent nào đang "nói", tool nào được gọi, runbook nào vừa được dùng/chưng cất.

### S1 · Kiểm tra MOTOR_01 — Runbook / Knowledge Compounding
Bấm **S1**. Vì pattern `motor-overheat-fan` đã có trong runbook wiki
(×3 lần trước đó), hệ thống **không suy luận lại từ đầu**:
- Trace hiện `⚡ Runbook hit` → áp SOP đã chưng cất, chỉ chạy IoT + Safety rồi thực thi.
- **Điểm flex:** hệ thống "thông minh dần" — runbook là bộ nhớ dài hạn của đàn agent.

### S2 · Xung đột cảm biến GAS_01 — Safety Gate + Human-in-the-loop
Bấm **S2**. Gas tăng lên ~55 ppm:
- **IoT Observation** đọc MQTT, **Safety Agent** đối chiếu safety envelope → `🚨 CRITICAL`.
- **AI Planner** sinh nhiều phương án, chấm điểm trên hàm mục tiêu đa tiêu chí
  (safety > production > energy) và chọn `purge_ventilation`.
- Vì là hành động critical → **không tự chạy**, mà tạo **Approval Card** (Human-in-the-loop).
- 👉 **Bấm APPROVE trên card**: Factory Action commit tool call (idempotent), read-back
  verify, áp mitigation lên fabric (gas giảm), notify shift-lead.
- 👉 Chạy lại S2 lần 2: lần này có runbook hit nhưng **safety gate không bao giờ bị bỏ qua**
  → vẫn ra approval. Đó là thiết kế có chủ đích: SOP tái sử dụng tăng tốc planning,
  nhưng an toàn luôn được đánh giá lại.
- **Điểm flex:** AI được phép đề xuất, con người giữ quyền quyết định hành động nguy hiểm.

### S3 · LINE_01 + Tool timeout — Idempotency & Audit
Bấm **S3**. Tool `/ops/workorders` bị timeout (mất ACK):
- Agent **không retry mù quáng** (sẽ tạo trùng work order) mà audit + retry bằng
  **idempotency key** → server-side dedup trả về đúng WO cũ (`TW_DEDUP`).
- Trace hiện đầy đủ: `TIMEOUT` → audit → `reuse WO-xxxx, not creating duplicate` → read-back `VERIFIED`.
- **Điểm flex:** chuẩn vận hành production-grade — at-least-once delivery + chống trùng + xác minh sau ghi.

### Tự do (flex Neuro-LLM nếu ONLINE)
- Gõ câu tự nhiên, vd: `"MOTOR_01 kêu to bất thường, chuẩn bị kiểm tra trước ca sau"`
  → trace hiện `Neuro-LLM parse → device=MOTOR_01, taskType=inspection` rồi orchestrator chạy.
- Sau mỗi task, chỉ vào panel **🧾 AI Incident Report**: LLM vừa viết tường trình từ audit trail.
- **⏻ EMERGENCY STOP**: xoá toàn bộ fault, tạo incident HIGH, đưa hệ thống về trạng thái an toàn.

---

## 🔬 "Flex" kỹ thuật — nói gì với giám khảo ở mỗi panel

| Panel | Thuật toán thật đang chạy | Câu chốt |
|---|---|---|
| **Agent Fleet & Runbook** | Pipeline orchestration realtime: 7 agent + Tool Gateway, LED hoạt động, msg counter, runbook wiki có occurrence tracking và ops log hit/apply/distill. | "Nhìn thấy đàn agent suy nghĩ và tích lũy tri thức trực tiếp — không cần mở log." |
| **Neuro-LLM link** | OpenRouter (deepseek-v4-flash) parse yêu cầu ngôn ngữ tự nhiên + viết báo cáo RCA từ audit trail; kết quả LLM luôn qua validate symbolic, lỗi/mất mạng tự rơi về symbolic-only. | "Neuro-symbolic đúng nghĩa: LLM là phần mềm, ràng buộc an toàn là phần cứng." |
| **Device grid + ADWIN/Kalman** | Mỗi tín hiệu MQTT chạy 1 rig **ADWIN** (cửa sổ thích ứng, Hoeffding bound) + 1 bộ **Kalman** scalar. ADWIN báo change-point khi phân phối trôi; Kalman tách nhiễu trước khi agent đọc. | "Anomaly detection chạy ở EDGE, per-signal, online — không retrain." |
| **Causal RCA Graph** | **Lag-correlation** online giữa mọi cặp tín hiệu → cạnh nhân quả có hướng (lead/lag), vẽ đồ thị động. | "Không chỉ phát hiện anomaly — chỉ ra tín hiệu nào DẪN tới tín hiệu nào." |
| **What-If Digital Twin** | Planner sinh N phương án, mỗi phương án được **mô phỏng tương lai** trên twin vật lý bậc nhất rồi chấm bằng **hàm mục tiêu đa tiêu chí** trước khi chạm vào nhà máy thật. | "Mọi quyết định đều đã được 'sống thử' trong twin trước khi thực thi." |
| **Multi-agent orchestration** | 7 agent: Supervisor, IoT Observation, Maintenance, Production, Safety, AI Planner, Factory Action — mỗi agent có vai trò, prompt và quyền riêng. | "Kiến trúc neuro-symbolic: LLM lập luận + ràng buộc biểu tượng (safety envelope, idempotency)." |
| **Tool layer** | `createWorkOrder` dedup theo (device, content, sourceTask); `verifyWorkOrder` đọc lại kết quả (read-back); timeout được xử lý bằng audit + retry idempotent. | "Tool call của agent an toàn như transaction: không trùng, có xác minh, có audit trail." |
| **Runbook wiki** | Mỗi ca xử lý thành công được **chưng cất** thành entry runbook; lần sau gặp lại pattern → đi tắt qua SOP. Số occurrences tăng dần = tri thức tích lũy. | "Hệ thống càng chạy càng giỏi — knowledge compounding." |

---

## 🗂 Cấu trúc mã nguồn

```
web/demo/
├── index.html            # Control-room layout (3 cột + engineering deep-dive)
├── css/style.css         # Dark HMI theme
└── js/
    ├── algorithms.js     # ADWIN, Kalman, CausalTracker (lag-correlation), WhatIfSim, hàm mục tiêu
    ├── simulator.js      # MQTT fabric giả lập: 6 thiết bị, ~4Hz, fault injection
    ├── agents.js         # ToolLayer (idempotency/verify/timeout) + 7 agent + Orchestrator + runbook wiki
    ├── llm.js            # Neuro-LLM link (OpenRouter): parse task + incident report, fallback-safe
    ├── config.example.js # mẫu cấu hình key (copy thành config.js — config.js gitignored)
    └── main.js           # Boot, render dashboard, viewers, scenario buttons, HITL approval handler
```

## 🧪 Kiểm thử

Đã verify headless bằng Node (không cần trình duyệt):

- ADWIN phát hiện drift khi phân phối đổi; Kalman hội tụ.
- S2: gas 55 ppm → `CRITICAL` → approval pending → APPROVE → WO `VERIFIED` + fault cleared.
- S3: timeout → retry dedup → đúng 1 work order, không trùng.
- Runbook: hit S1, distill sau ca mới, occurrences tăng.
- Boot DOM không lỗi; mọi panel render.

## 📎 Tham chiếu

Kiến trúc chi tiết trong `tai lieu/01..07` (đánh giá architecture, thiết kế agent,
edge intelligence, causal RCA, digital twin, tool safety, knowledge compounding).
