bộ data để tôi làm mô phỏng test thử

Có. Với architecture **Agentic AI + IoT + anomaly detection + causal RCA + Digital Twin + self-healing** của bạn, tôi khuyên **không cố tìm một dataset duy nhất**. Các dataset công khai hiện nay thường chỉ cover một vài tầng; cách làm research tốt hơn là ghép **2–3 benchmark** để test từng capability.

### 4 bộ tôi ưu tiên nhất

| Dataset                                      | Dùng để test                               | Phù hợp đề tài |
| -------------------------------------------- | ------------------------------------------ | -------------- |
| **🥇 SWaT**                                  | anomaly + actuator + cyber-physical RCA    | ⭐⭐⭐⭐⭐          |
| **🥈 Tennessee Eastman + Manipulation 2026** | causal AI + counterfactual + Digital Twin  | ⭐⭐⭐⭐⭐          |
| **🥉 HAI**                                   | ICS anomaly + cyberattack + self-healing   | ⭐⭐⭐⭐⭐          |
| **NASA C-MAPSS**                             | predictive maintenance + forecasting + RUL | ⭐⭐⭐⭐           |

Nếu làm prototype hoàn chỉnh, tôi sẽ dùng **SWaT + TEP Manipulation + C-MAPSS/Paderborn**.

---

# 1. SWaT — hợp architecture của bạn nhất

## Secure Water Treatment

Đây gần như là dataset sinh ra để thử hệ thống bạn đang vẽ.

SWaT là một testbed xử lý nước công nghiệp **6 giai đoạn**, có PLC, sensor, actuator, network và SCADA. Dataset có các giai đoạn vận hành bình thường lẫn cyber-physical attacks. iTrust mô tả nó là bản thu nhỏ nhưng có độ trung thực cao của một water-treatment facility thực; dữ liệu chứa các giá trị sensor và actuator trong quá trình hoạt động. ([SUTD][1])

Ví dụ dữ liệu kiểu:

```text
timestamp
FIT101      flow
LIT101      water level
MV101       motorized valve
P101        pump
AIT201      chemical sensor
PIT501      pressure
...
```

Bạn có thể biến thẳng thành:

```text
SWaT CSV
   ↓
Kafka replay
   ↓
Edge anomaly detector
   ↓
Anomaly Event
   ↓
Causal RCA Agent
   ↓
"What component caused the anomaly?"
   ↓
Planner
   ↓
Simulated remediation
```

### Tại sao rất hợp với bạn?

Ví dụ attack:

```text
MV101 đóng bất thường
       ↓
flow giảm
       ↓
tank level thay đổi
       ↓
downstream process bị ảnh hưởng
```

Causal graph:

```text
MV101
  ↓
FIT101
  ↓
LIT101
  ↓
P101
```

Agent có thể suy luận:

```text
Observed:
FIT101 ↓
LIT101 ↑

Root cause:
MV101 unexpectedly closed

Proposed action:
restore MV101 state

Safety verification:
PASS
```

Đó chính xác là:

> **Detect → RCA → Plan → Simulate → Act**

Bạn thậm chí không cần PLC thật.

PLC simulator của bạn chỉ cần một service Python nhận:

```json
{
  "asset": "MV101",
  "action": "OPEN"
}
```

rồi giả lập thay đổi state.

### Access

SWaT được iTrust cung cấp cho nghiên cứu; trang iTrust hiện mô tả các dataset của họ là được chia sẻ cho researcher trên thế giới miễn phí, dù một số bộ cần đăng ký/request trước. ([SUTD][2])

**Đánh giá:** `9.5/10 cho project của bạn`.

---

# 2. Tennessee Eastman Process — cực mạnh cho Causal AI

Nếu SWaT phù hợp phần Smart Ops thì **TEP phù hợp phần research AI**.

Tennessee Eastman Process là benchmark mô phỏng một quy trình hóa chất phức tạp với nhiều process variables và fault conditions, từ lâu được dùng cho fault detection và diagnosis. ([Dataverse][3])

Architecture:

```text
Sensors
  ↓
Pressure
Temperature
Flow
Composition
...
  ↓
Fault
```

Tức rất giống:

```text
Industrial IoT telemetry
```

---

# 3. Cực đáng chú ý: TEP Manipulation Dataset 2026

Cái này tôi thấy **rất hợp ý tưởng World Model / Counterfactual của bạn**.

Carnegie Mellon University hiện có dataset:

## Dataset of Manipulations on the Tennessee Eastman Process

Dataset được cập nhật/public vào **19/03/2026**, chứa **286 interventions/manipulations**. Mỗi experiment cố ý thay đổi một feature của TEP trong khoảng hai giờ rồi ghi lại phản ứng tiếp theo của toàn hệ thống. ([Kilthub][4])

Đây là vàng cho causal AI.

Thông thường dataset chỉ cho:

```text
X1 ↑
X5 ↓
X8 ↑
```

Bạn phải đoán:

```text
X1 gây X5?
hay X5 gây X1?
```

Nhưng intervention dataset có kiểu:

```text
DO(X1 = X1 + Δ)
         ↓
observe
X5, X8, X12, X16...
```

Tức gần với:

[
P(Y|do(X=x))
]

Bạn có thể học:

```text
Pressure
   ↓
Flow
   ↓
Temperature
```

thay vì correlation đơn thuần.

---

# 4. Với nó bạn làm được Counterfactual Agent

Bạn có thể build:

```text
Current:
Pressure = 9.8 bar
Temperature = 91°C

Agent asks World Model:

"What happens if valve V3 closes 20%?"
```

Model:

```text
Flow       -14%
Pressure   +8%
Temp       +3°C
```

Planner thử:

```text
Action A:
V3 -20%

Action B:
Pump -10%

Action C:
Cooling +15%
```

World Model simulate cả ba.

Sau đó:

```text
Risk Agent
      ↓
cho score
      ↓
Safety Shield
      ↓
chọn action
```

Đây chính là phần:

> **What if I do X?**

mà tôi nói với bạn lúc trước.

**TEP Manipulation 2026: 10/10 cho Causal/Digital Twin layer.**

---

# 5. HAI — rất ngon cho Industrial Cyber + Agentic Ops

## HIL-based Augmented ICS Security Dataset

HAI được thu từ một Industrial Control System testbed dùng **Hardware-in-the-Loop**, mô phỏng cả hệ thống phát điện turbine hơi và pumped-storage hydropower. ([GitHub][5])

Dataset được thiết kế cho:

```text
ICS
+
CPS
+
Anomaly Detection
+
Cyberattack
```

HAI 1.0 chẳng hạn có training normal operation và test data chứa hàng chục attack scenarios; các phiên bản sau tiếp tục mở rộng scenario và datapoint. ([USENIX][6])

Bạn có:

```text
Sensor
Actuator
Controller
Process
Attack
```

nên có thể mô phỏng:

```text
attacker
    ↓
sensor manipulation
    ↓
AI detects anomaly
    ↓
RCA Agent
    ↓
Cybersecurity Agent
    ↓
"is this equipment fault
 or sensor spoofing?"
```

Câu này rất hay.

Ví dụ:

```text
Sensor:
pressure = 300

Physics Model:
expected pressure ≈ 210

Other sensors:
flow remains normal
temperature normal

Agent conclusion:
Sensor spoofing more likely
than physical pressure fault.
```

Rồi:

```text
Action:
isolate compromised input
switch to estimated sensor value
alert operator
```

Đây là **Cyber-Physical Self-Healing**.

HAI repo chính thức hiện public toàn bộ dataset. ([GitHub][5])

---

# 6. NASA C-MAPSS — cho Predictive AI / TS Foundation Model

Nếu bạn muốn thêm:

> **What will happen?**

thì C-MAPSS rất tốt.

NASA C-MAPSS là multivariate run-to-failure simulation của turbofan engines. Mỗi engine bắt đầu ở trạng thái tương đối bình thường, rồi fault phát triển dần cho đến failure; dataset có operational settings, sensor measurements, train/test trajectories và ground-truth remaining useful life. ([NASA Open Data][7])

Có 4 nhóm chính:

```text
FD001
1 operating condition
1 fault mode

FD002
6 conditions
1 fault mode

FD003
1 condition
2 fault modes

FD004
6 conditions
2 fault modes
```

NASA hiện cung cấp trực tiếp file ZIP trên Open Data portal. ([NASA Open Data][7])

Bạn có thể thử:

```text
Isolation Forest
LSTM
Transformer
PatchTST
TimesFM/Chronos-style model
     ↓
predict
RUL / sensor future / failure risk
```

Ví dụ:

```text
Engine 42

Current Health Score: 0.41
Estimated RUL: 37 cycles
Failure probability:
 next 10 cycles: 7%
 next 30 cycles: 52%
```

Rồi đưa vào Planner:

```text
Maintenance Agent:
Schedule maintenance before cycle 25.
```

---

# 7. XJTU-SY Bearing Dataset

Nếu bạn muốn làm **motor/bearing**, cái này còn thực tế hơn C-MAPSS.

XJTU-SY là accelerated run-to-failure bearing dataset. Nó chứa vibration signals xuyên suốt vòng đời của nhiều bearings và có các kiểu failure thực nghiệm như inner-race wear, outer-race wear/fracture, cage fracture. ([Biaowang Tech][8])

Có thể làm:

```text
raw vibration
      ↓
FFT / Wavelet
      ↓
Edge AI
      ↓
health index
      ↓
RUL
```

Và từ đó:

```text
bearing degradation
       ↓
Agent:
"reduce motor load?"
       ↓
Digital Twin
       ↓
simulate
```

Rất hợp nếu demo của bạn là:

> **Smart Motor Operations**

thay vì nhà máy nước.

---

# 8. Paderborn Bearing Dataset — tôi còn thích hơn nếu làm multimodal

Paderborn University cung cấp benchmark condition-monitoring có đồng thời:

```text
Vibration
Motor current
Speed
Torque
Radial load
Temperature
```

Dataset gồm **26 damaged bearing states + 6 healthy states**, được đo dưới **4 operating conditions**, cùng high-resolution vibration và motor-current measurements. ([MB Universität Paderborn][9])

Cái này rất đẹp cho **multimodal RCA**:

```text
vibration ↑
temperature ↑
current ↑
torque abnormal
      ↓
Causal RCA
      ↓
bearing defect
```

Thay vì:

```text
anomaly = vibration high
```

---

# 9. NASA IMS Bearing

NASA cũng đang host IMS Bearings public trên Open Data portal. Đây là experimental bearing degradation dataset từ Center for Intelligent Maintenance Systems, University of Cincinnati. ([NASA Open Data][10])

Dùng rất tốt cho:

```text
Streaming vibration
       ↓
Anomaly Detector
       ↓
Health degradation
       ↓
Failure prediction
```

Ưu điểm:

* nhẹ;
* dễ bắt đầu;
* run-to-failure;
* rất nhiều code benchmark đã tồn tại.

Nhược:

* không có hệ PLC/process phức tạp;
* RCA không thú vị bằng SWaT/TEP.

---

# 10. DCASE / MIMII — thêm audio AI vào là khá “flex”

Nếu muốn Edge AI của bạn nhìn xịn hơn:

```text
Temperature
Vibration
Current
+
Microphone
```

DCASE hiện vẫn tổ chức bài toán **First-Shot Unsupervised Anomalous Sound Detection for Machine Condition Monitoring**, và challenge **2026** tiếp tục hướng này. ([Dcase][11])

MIMII/DCASE cung cấp industrial-machine sounds như:

```text
Fan
Pump
Valve
Slide rail
```

có normal và anomalous sound; các anomaly thực tế gồm leakage, contamination, rotating imbalance, rail damage... ([Dcase][12])

Architecture:

```text
Microphone
   ↓
Mel Spectrogram
   ↓
Audio Foundation Model
   ↓
Acoustic anomaly
```

Fusion:

```text
vibration anomaly = 0.81
audio anomaly     = 0.92
temperature       = normal
          ↓
RCA Agent
```

Rất dễ tạo demo ấn tượng.

---

# 11. TON_IoT — nếu muốn Security Agent riêng

TON_IoT của UNSW được thiết kế cho IoT/IIoT cybersecurity, sử dụng môi trường Industry 4.0/IoT và phục vụ evaluation các mô hình AI-based security. ([UNSW Sites][13])

Bạn có thể thêm:

```text
Network telemetry
      ↓
Security Agent
```

vào architecture:

```text
Physical telemetry ───► Condition Agent

Network traffic ──────► Security Agent

Logs ─────────────────► RCA Agent

                 ↓
          Supervisor Agent
```

Khi có anomaly:

```text
pump stops
```

Agent phải phân biệt:

```text
Mechanical fault?

PLC fault?

Network attack?

Sensor spoof?

Operator command?
```

Đây mới thực sự là **Root Cause Analysis**.

---

# Nếu là project của bạn, tôi sẽ KHÔNG dùng 10 bộ

Tôi sẽ chọn thế này:

## Dataset A — SWaT

Dùng cho:

```text
Realistic industrial telemetry
Anomaly Detection
Event streaming
RCA
Agent
PLC simulation
Closed loop
```

↓

## Dataset B — TEP Manipulation 2026

Dùng cho:

```text
Causal Graph
Counterfactual reasoning
Digital Twin
World Model
Action simulation
```

↓

## Dataset C — Paderborn

Dùng cho:

```text
Predictive Maintenance
Edge AI
Multimodal sensor fusion
```

Thành một research testbed rất đẹp:

```text
             SMART OPS BENCHMARK

                    Dataset
                       │
       ┌───────────────┼───────────────┐
       ▼               ▼               ▼
     SWaT            TEP            Paderborn
       │               │               │
       ▼               ▼               ▼
 Anomaly/RCA       Causal AI       Predictive
 Closed-loop       World Model     Maintenance
       │               │               │
       └───────────────┬───────────────┘
                       ▼
               Agentic Smart Ops
```

---

# Còn nếu muốn bắt tay code ngay

Tôi nghĩ **bắt đầu bằng SWaT** là tối ưu nhất cho architecture trong ảnh của bạn.

Pipeline V1:

```text
SWaT.csv
   │
   ▼
Python Replay Simulator
   │
   │ 1 sample/sec
   ▼
MQTT
   │
   ▼
Kafka
   │
   ├──────────────► InfluxDB
   │                    ↓
   │                 Grafana
   │
   ▼
Edge Detector
Isolation Forest
   │
anomaly_score > threshold
   ▼
Event
{
 machine,
 sensor,
 values,
 anomaly_score
}
   │
   ▼
RCA Agent
   │
   ├── Asset graph
   ├── Historical state
   ├── SOP
   └── causal dependencies
   │
   ▼
Candidate Actions
   │
   ▼
Digital Twin Simulator
   │
   ▼
Safety Shield
   │
   ├── SAFE → Execute
   │
   └── UNSAFE → Human Approval
   │
   ▼
Virtual PLC
   │
   ▼
Change simulator state
   │
   └──────────────↺
```

Sau đó V2 thay:

```text
Isolation Forest
```

bằng:

```text
Isolation Forest      ← baseline
Autoencoder
Transformer
Time-Series FM
```

V3:

```text
LLM RCA
```

vs:

```text
LLM + Knowledge Graph
```

vs:

```text
LLM + Causal Graph
```

V4:

```text
LLM → action
```

vs:

```text
LLM
 ↓
World Model
 ↓
Safety Shield
 ↓
action
```

Như vậy bạn có **ablation study rất rõ**, chứ không phải chỉ dựng một hệ thống rồi demo.

### Các metric cũng ra rất đẹp

```text
Anomaly Detection
-----------------
Precision
Recall
F1
Detection delay

Prediction
----------
MAE
RMSE
RUL error

RCA
---
Top-1 root cause accuracy
Top-3 root cause accuracy
RCA latency

Agent
-----
Action success rate
Unsafe action rate
Recovery time

Smart Ops
---------
MTTD
MTTR
Downtime avoided
False intervention rate
```

Và đây chính là chỗ có khả năng thành một bài research tử tế:

> **Hệ thống không chỉ phát hiện fault chính xác bao nhiêu %, mà còn có thể tìm đúng nguyên nhân, đưa ra action đúng và phục hồi hệ thống nhanh đến đâu.**

**Một lưu ý quan trọng:** qua các dataset chính thức tôi rà ở trên, tôi chưa thấy một public dataset duy nhất vừa có đầy đủ `industrial telemetry + failure progression + network attacks + causal intervention + SOP + incident RCA + remediation outcome`. Vì vậy, theo tôi, thiết kế benchmark ghép **SWaT + TEP Manipulation + Paderborn/C-MAPSS** thực ra hợp lý hơn việc ép toàn bộ research vào một dataset. Đây là suy luận từ phạm vi dữ liệu mà từng nguồn công bố. ([SUTD][1])

Nếu chọn **một bộ duy nhất để tải về và code ngày mai**, chọn **SWaT**. Nếu chọn **một bộ để làm phần khó/mới nhất của research**, chọn **TEP Manipulation 2026**.

[1]: https://www.sutd.edu.sg/itrust/itrust-labs/datasets/dataset-characteristics/swat/?utm_source=chatgpt.com "Secure Water Treatment (SWaT) - Datasets"
[2]: https://www.sutd.edu.sg/itrust/?utm_source=chatgpt.com "iTrust"
[3]: https://dataverse.harvard.edu/dataset.xhtml?persistentId=doi%3A10.7910%2FDVN%2F6C3JR1&utm_source=chatgpt.com "Additional Tennessee Eastman Process Simulation Data ..."
[4]: https://kilthub.cmu.edu/articles/dataset/Dataset_of_Manipulations_on_the_Tennessee_Eastman_Process/23805552?utm_source=chatgpt.com "Dataset of Manipulations on the Tennessee Eastman ..."
[5]: https://github.com/icsdataset/hai?utm_source=chatgpt.com "HAI (HIL-based Augmented ICS) Security Dataset"
[6]: https://www.usenix.org/system/files/cset20-paper-shin.pdf?utm_source=chatgpt.com "HAI 1.0: HIL-based Augmented ICS Security Dataset"
[7]: https://data.nasa.gov/dataset/cmapss-jet-engine-simulated-data?utm_source=chatgpt.com "CMAPSS Jet Engine Simulated Data - Dataset"
[8]: https://biaowang.tech/xjtu-sy-bearing-datasets/?utm_source=chatgpt.com "XJTU-SY滚动轴承加速寿命实验数据集 / XJTU-SY Bearing ..."
[9]: https://mb.uni-paderborn.de/kat/forschung/bearing-datacenter/data-sets-and-download?utm_source=chatgpt.com "Data Sets and Download - Konstruktions- und Antriebstechnik ..."
[10]: https://data.nasa.gov/dataset/ims-bearings?utm_source=chatgpt.com "IMS Bearings - Dataset"
[11]: https://dcase.community/challenge2026/task-first-shot-unsupervised-anomalous-sound-detection-for-machine-condition-monitoring?utm_source=chatgpt.com "Noise-aware Unsupervised Anomalous Sound Detection ..."
[12]: https://dcase.community/challenge2020/task-unsupervised-detection-of-anomalous-sounds?utm_source=chatgpt.com "Unsupervised Detection of Anomalous Sounds for Machine ..."
[13]: https://research.unsw.edu.au/projects/toniot-datasets?utm_source=chatgpt.com "The TON_IoT Datasets - UNSW Research"
