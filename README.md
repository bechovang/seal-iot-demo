# SEAL Hackathon 2026 — Track C: Smart Factory
## Neuro-Symbolic Multi-Agent Industrial Operations (AI-Ops Commander)

Bài dự thi Track C — hệ thống **đa AI agent** vận hành nhà máy thông minh:
quan trắc IIoT qua MQTT, phát hiện bất thường ở edge (**ADWIN + Kalman**),
suy luận **nhân quả (causal RCA)**, mô phỏng **What-If Digital Twin**,
gọi **Tool/API an toàn** (idempotency · read-back verify · timeout handling),
cổng phê duyệt **Human-in-the-loop**, và **tích lũy tri thức runbook**.

## ▶ Chạy demo (không cần cài đặt)

```
Mở file  web/demo/index.html  bằng trình duyệt → xong.
```

Kịch bản demo 3 phút + "talk track" cho giám khảo: xem **[`web/demo/README.md`](web/demo/README.md)**.

## 🗂 Cấu trúc repo

```
web/demo/          # Control-room dashboard (HTML/CSS/JS thuần — self-contained)
├── index.html     #   layout 3 cột + engineering deep-dive (4 tab)
└── js/
    ├── algorithms.js   # ADWIN, Kalman, CausalTracker (lag-correlation), WhatIfSim, hàm mục tiêu
    ├── simulator.js    # MQTT fabric giả lập: 6 thiết bị @ ~4Hz, fault injection
    ├── agents.js       # ToolLayer + 7 agent + Orchestrator + runbook wiki
    └── main.js         # boot, render, scenario hooks, HITL approval handler

tai lieu/          # Hồ sơ nghiên cứu & thiết kế
├── 01..07-*.md    # đánh giá architecture, rà soát paper, bộ dữ liệu, phân tích agent...
├── de_track_C.txt # đề bài Track C
├── showcase.txt   # nội dung showcase
└── tai-lieu-tham-khao/  # ~35 paper nền tảng (causal RCA, agentic IoT, digital twin...)
```

## 📦 Ghi chú về bộ dữ liệu

Thư mục `tai lieu/bo-du-lieu/` chứa link/mô tả các bộ dữ liệu công khai
(**HAI 21.03**, **CMAPSS**, **XJTU-SY**). File nén dataset gốc (`.zip`, `.csv.gz` —
tới 1.6 GB) **không đưa vào repo** vì giới hạn dung lượng GitHub; tải trực tiếp
từ nguồn được ghi trong các file `.html`/`.json` cùng thư mục. Bản demo web dùng
simulator telemetry tự sinh nên không phụ thuộc file dataset.

## 🔑 Điểm kỹ thuật nổi bật

- **Edge intelligence online**: ADWIN (Hoeffding bound) + Kalman chạy per-signal, không retrain.
- **Neuro-symbolic**: LLM-style agents lập luận + ràng buộc biểu tượng (safety envelope, idempotency keys).
- **Digital twin what-if**: mọi hành động được mô phỏng & chấm điểm đa tiêu chí trước khi thực thi.
- **HITL**: hành động safety-critical luôn chờ con người phê duyệt — kể cả khi đã có runbook.
- **Knowledge compounding**: mỗi ca xử lý thành công chưng cất thành runbook; lần sau đi tắt qua SOP.
