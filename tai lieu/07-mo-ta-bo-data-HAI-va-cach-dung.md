# Bộ dữ liệu HAI (HIL-based Augmented ICS) — mô tả sơ bộ & cách dùng cho SEAL Summer 2026

> Trạng thái: đã tải `hai-21.03/train1.csv.gz` (30 MB) + `hai-21.03/test1.csv.gz` (6 MB) vào
> `tai lieu/bo-du-lieu/03-HAI/`. Đã đọc và kiểm tra結 cấu bằng pandas.
> Nguồn: https://github.com/icsdataset/hai (public, không cần đăng ký).

## 1. Vì sao chọn HAI làm bộ data luyện/test chính

Hệ thống mô phỏng của BTC SEAL là "biến số bí mật" đến chiều Ngày 1 — chỉ biết là
**telemetry IoT theo thời gian thực qua MQTT/API**. HAI là bộ mô phỏng gần nhất với mô tả đó:

| Yêu cầu luyện tập | HAI đáp ứng |
| --- | --- |
| Telemetry đa biến, streaming, nhịp đều | 80 cột sensor/actuator, **1 dòng/giây** |
| Nhiều "trạm"/khu vực trong 1 hệ | 4 khu vực process: P1 boiler, P2 HIL, P3 water, P4 turbine |
| Có cả sensor lẫn actuator | Tag `*_Z`, `*_D` (setpoint/feedback), van FCV/LCV/PCV, breaker |
| Có sự cố để test detect + chấm điểm | Cột label `attack`, `attack_P1/P2/P3` (ground truth sẵn) |
| Sự cố ở nhiều nơi để test RCA lan truyền | Attack ở P1 và P2, hiệu ứng thể hiện trên nhiều tag liên quan |
| Vừa-sized để iterate nhanh | ~43k dòng/file test, ~30 MB nén |

Không thay thế được C-MAPSS (đã có sẵn trong `bo-du-lieu/04-CMAPSS/`) cho mảng
**degradation/RUL mượt thời gian dài** — HAI là sự cố gián đoạn (attack), C-MAPSS là
suy hao dần. Hai bộ dùng cho hai kịch bản demo khác nhau (xem §5).

## 2. Các phiên bản có trong repo

| Thư mục | Nội dung | Ghi chú |
| --- | --- | --- |
| `hai-20.07` (v1.0) | train1/2, test1/2 (~110 MB tổng) | 59 cột, testbed 2 khu vực |
| `hai-21.03` (v2.0) | train1–3, test1–5 | **84 cột**, đủ 4 khu vực P1–P4 ⭐ đang dùng |
| `hai-22.04` (v3.0) | nhiều file + `summary/` | 87 cột, có stealthy attack (khó hơn) — dùng ở vòng nâng cao |
| `graph/` | Sơ đồ topology DCS dạng PNG + JSON | **Quà**: sẵn material cho Asset Topology/Knowledge Graph |

Link tải trực tiếp (raw, không cần git clone cả repo ~530 MB):

```text
https://raw.githubusercontent.com/icsdataset/hai/master/hai-21.03/train1.csv.gz
https://raw.githubusercontent.com/icsdataset/hai/master/hai-21.03/test1.csv.gz
```

## 3. Cấu trúc `hai-21.03/test1.csv.gz` (đã kiểm chứng)

- **Shape:** 43.201 dòng × 84 cột
- **Thời gian:** 2020-07-07 15:00:00 → 2020-07-08 03:00:00 (12 giờ, nhịp 1 s)
- **Không có NaN** ở bất kỳ cột nào

### 3.1 Phân nhóm cột theo khu vực

| Prefix | Khu vực | Số cột | Vai trò trong "factory" của mình |
| --- | --- | --- | --- |
| `P1_*` | Boiler (steam) | ~39 | "Trạm 1" — nhiệt/nước/hơi |
| `P2_*` | HIL (hardware-in-the-loop) | ~23 | "Trạm 2" — controller/turbine I/O |
| `P3_*` | Water treatment | 7 | "Trạm 3" — bồn/máy bơm |
| `P4_*` | Turbine chính | 11 | "Trạm 4" — phát điện |
| `attack*` | Label | 4 | Ground truth (bỏ khỏi input của model) |

### 3.2 Đọc tag công nghiệp (để viết mapping.yaml nhanh)

| Hậu tố/tag | Ý nghĩa | Ví dụ |
| --- | --- | --- |
| `*_FT*` | Flow Transmitter (lưu lượng) | `P1_FT01` |
| `*_LIT*` | Level Indicating Transmitter (mực) | `P1_LIT01`, `P3_LIT01` |
| `*_PIT*` | Pressure Indicating Transmitter | `P1_PIT01` |
| `*_TIT*` | Temperature Indicating Transmitter | `P1_TIT01`, `P4_ST_TT01` |
| `*_FCV*` / `*_LCV*` / `*_PCV*` | Flow/Level/Pressure Control Valve | `P1_FCV01D` |
| `*_D` vs `*_Z` | Setpoint (Demand) vs giá trị thực (feedback) | `P1_FCV01D` / `P1_FCV01Z` |
| `P1_B*` | Breaker/điện | `P1_B2004` |
| `P2_*rpm`, `P2_Emerg`, `P2_TripEx` | Trạng thái HIL/turbine | |

Cặp `*_D`/`*_Z` đặc biệt quý: chênh lệch setpoint–feedback là tín hiệu "actuator không
nghe lệnh" — nguyên liệu cho causal RCA (hưng)
và cho story "sensor spoofing vs physical fault" (doc 03 §5).

### 3.3 Các đợt attack trong test1 (ground truth)

| # | Thời gian (2020-07-07) | Durability | Khu vực |
| --- | --- | --- | --- |
| 1 | 15:35:11 → 15:38:22 | 192 s | P1 |
| 2 | 17:28:11 → 17:29:48 | 98 s | P1 |
| 3 | 18:59:11 → 19:02:20 | 190 s | P1 |
| 4 | 20:21:06 → 20:22:05 | 60 s | P2 |
| 5 | 21:03:21 → 21:04:49 | 89 s | P2 |

→ 629/43.201 dòng attack (~1.5%). Đợt dài nhất ~3 phút — đủ dài cho một khoảnh khắc
demo "phát hiện → chẩn đoán → hành động" mà không phải chờ đợi.

## 4. Áp vào kiến trúc Smart Ops Harness

```text
HAI csv.gz ──replay 1 dòng/giây──► MQTT (mosquitto local)   ← đóng vai "BTC sim"
      │                                │
      └── mapping.yaml ────────────────┘   topic/field → canonical signal
              (viết 1 lần cho HAI, thi đấu ngày viết cho BTC)

PERCEIVE   Kalman/EMA + ADWIN trên từng signal → anomaly event
DIAGNOSE   lag-correlation/Granger giữa các tag + topology (dùng graph/ trong repo)
           → RCA agent: "attack_P1 kiểu này: setpoint đổi nhưng feedback không theo
              → van/actuator bị thao túng, không phải sensor hỏng"
DECIDE     what-if sim + objective function + safety shield
LEARN      runbook wiki (bắt đầu rỗng) + incident FSM SQLite
```

Lợi thế riêng khi luyện với HAI:

1. **Chấm điểm khách quan ngay khi luyện tập** — nhờ label `attack*` mình tính được
   Precision/Recall/F1, detection delay (bao nhiêu giây sau khi attack bắt đầu mới
   phát hiện), false-alarm trên đoạn normal — đúng các metric doc 03 đã列出.
2. **Topology có sẵn** — `graph/boiler/dcs_*.json` + `phy_boiler.json` chứa sơ đồ
   quan hệ thiết bị thật của testbed → nạp thẳng vào Asset Knowledge Graph thay vì
   tự vẽ.
3. **Luyện đúng kỹ năng Ngày-1**: thời gian luyện đo bằng "từ mở file csv đến pipeline
   chạy là bao lâu" — mục tiêu giảm dần xuống dưới 60 phút.

## 5. Phân vai data khi luyện tập & demo

| Bộ data | Vai trò | Kịch bản |
| --- | --- | --- |
| HAI 21.03 | Mock "BTC sim" chính | Replay streaming qua MQTT; gây sự cố = nhảy tới timestamp có attack |
| C-MAPSS (đã có) | Degradation dài hạn | Kịch bản "predictive": RUL giảm dần → planner lên lịch bảo trì trước |
| HAI 22.04 (tải sau nếu cần) | Chế độ khó | Stealthy attack để test độ nhạy detector, dùng vòng luyện nâng cao |

## 6. Hạn chế cần biết

- HAI là **ICS/process** (nước–hơi–điện), không phải dây chuyền lắp ráp — skin
  "smart factory" khi thi phụ thuộc track thật; các lớp của harness không đổi, chỉ
  đổi `mapping.yaml` + từ vựng domain trong UI.
- Không có cột "production throughput" — khi cần thành tố Throughput trong objective
  function phải suy ra từ tag process (ví dụ flow/steam output) hoặc mô phỏng thêm.
- Telemetry 1 Hz — khi thi nếu BTC phát nhanh hơn (10 Hz+) cần kiểm tra lại hiệu năng
  ADWIN/Kalman (throttle hoặc window sampling).

## 7. Bước tiếp theo đề xuất

1. Viết replay script: đọc csv.gz → publish MQTT theo thời gian thực (kèm nút
   "tua tới attack tiếp theo" để demo không phải chờ).
2. Smoke test tầng PERCEIVE: ADWIN trên `P1_PIT01`/`P1_LIT01` quanh cửa sổ attack 1,
   đo detection delay so với 15:35:11.
3. Dựng `mapping.yaml` cho HAI — đây chính là template luyện cho mapping BTC Ngày 1.
4. Nếu muốn tăng độ khó: tải thêm `hai-22.04/test*.csv.gz` (stealthy attack).
