Được — nếu muốn "flex" kỹ thuật thật sự (không chỉ là gọi LLM API rồi in ra chữ), thì cần thêm **1-2 kỹ thuật có chiều sâu thuật toán thật**, chứ không chỉ là prompt engineering. Dưới đây là các kỹ thuật "khó, xịn" nhưng vẫn khả thi trong ~7 tiếng vì có thể code gọn (không cần train model lớn).

## Kỹ thuật đáng flex nhất (xếp theo độ ấn tượng kỹ thuật / độ khả thi)

### 1. Causal Graph Root Cause Analysis (thay vì chỉ hỏi LLM "tại sao")
Đây là kỹ thuật xịn thật — đúng cái paper RCLAgent/Flow-of-Action nhắc tới.

**Cách làm nhanh:** Từ dữ liệu multi-sensor real-time, tính **correlation matrix / lag correlation** giữa các biến (nhiệt độ, dòng điện, rung động...) → dựng thành **đồ thị nhân-quả đơn giản** (dùng thư viện như `networkx` + Pearson/Granger causality cơ bản) → đưa đồ thị này cho LLM để nó suy luận trên graph thay vì suy luận mù trên số liệu thô.

```
Metric A tăng → (lag 2s) → Metric B tăng → (lag 5s) → Metric C tăng
```
→ AI kết luận: "A là nguyên nhân gốc, B và C là hệ quả lan truyền" — đây là thứ **không đội nào khác nghĩ tới làm trong hackathon**, vì hầu hết chỉ hỏi thẳng LLM "tại sao lỗi" mà không dựng graph trước.

**Độ khó:** Trung bình, code ~1-1.5 tiếng nếu dùng sẵn `networkx` + `statsmodels` (Granger causality có sẵn hàm).

---

### 2. Concept Drift Detection thật (ADWIN/Page-Hinkley) — không phải threshold tĩnh
Thay vì if/else "nhiệt độ > 50 là bất thường" (ai cũng làm được), dùng thuật toán **online drift detection** thật sự từ literature (ADWIN — Adaptive Windowing), có sẵn trong thư viện `river` (Python, chuyên cho streaming ML).

```python
from river import drift
detector = drift.ADWIN()
# feed từng điểm dữ liệu real-time
# detector phát hiện khi phân phối dữ liệu "trôi" khỏi baseline
```

**Điểm flex:** Khi giám khảo hỏi "sao biết cái này là bất thường mà không phải nhiễu bình thường?" — bạn trả lời bằng thuật toán thống kê có tên, có paper, chứ không phải "em set ngưỡng 50 độ". Đây là điểm cực kỳ ăn điểm khi ban giám khảo có dân kỹ thuật.

**Độ khó:** Thấp — thư viện `river` cài `pip install river`, tích hợp streaming rất nhanh, ~30-45 phút.

---

### 3. Digital Twin "What-If Simulation" trước khi hành động (World Model mini)
Đây là ý hay nhất để **flex** — đúng hướng "frontier" (World Model) trong tài liệu nhưng làm phiên bản nhẹ.

**Ý tưởng:** Trước khi AI ra lệnh điều khiển actuator thật, nó **mô phỏng trước hậu quả** bằng 1 model vật lý/thống kê đơn giản (không cần deep learning):

```
Trạng thái hiện tại
      ↓
Digital Twin (simple simulation: linear/physics-based model)
      ↓
Thử 3 phương án: [Giảm tải 20%] [Tắt máy] [Tăng làm mát]
      ↓
Dự đoán kết quả từng phương án (nhiệt độ sau 30s tiếp theo)
      ↓
Chọn phương án tối ưu → mới thực thi thật
```

**Cách làm nhanh:** Không cần physics engine phức tạp — chỉ cần 1 hàm dự đoán tuyến tính đơn giản dựa trên dữ liệu lịch sử gần nhất (extrapolation), hoặc regression nhỏ train real-time. Cái quan trọng là **UI cho giám khảo thấy AI "tưởng tượng" ra 3 tương lai rồi mới chọn** — đây là điểm khác biệt lớn so với AI "phản xạ tức thời" của đội khác.

**Độ khó:** Trung bình-cao, cần ~2 tiếng, rủi ro nếu code không xong kịp — nên làm **fallback đơn giản** nếu hết giờ (bỏ qua simulation, action thẳng).

---

### 4. Multi-Agent Debate/Consensus trước khi hành động (Safety-critical AI)
Kỹ thuật này đang rất "hot" trong nghiên cứu AI safety 2025-2026: thay vì 1 LLM quyết định, dùng **2 agent phản biện nhau**:

```
Agent Đề xuất: "Nên tắt máy ngay vì nhiệt độ nguy hiểm"
        ↓
Agent Phản biện: "Dữ liệu chỉ có 1 điểm bất thường, có thể là nhiễu cảm biến, 
                  đề nghị theo dõi thêm 10s trước khi tắt"
        ↓
Agent Trọng tài: quyết định cuối, có giải thích lý do
```

**Điểm flex:** Đây chính là kỹ thuật **guardrail/safety layer** thật sự dùng trong production AI agent (không phải chỉ 1 LLM tự quyết rồi hành động bừa) — cực kỳ hợp với chủ đề "Intelligent Decisions" của đề bài, và trả lời rất tốt câu hỏi giám khảo hay hỏi: "Làm sao đảm bảo AI không ra quyết định sai gây hại phần cứng thật?"

**Độ khó:** Thấp-trung bình — chỉ cần gọi LLM API 2-3 lần với vai trò khác nhau (~1 tiếng).

---

## 🎯 Combo tôi đề xuất để vừa "flex" vừa an toàn deadline

Không làm hết 4 cái — chọn **2 kỹ thuật lõi + 1 backup**, ghép vào pipeline gốc:

```
Sensor (kit thật) → MQTT
        ↓
[Kỹ thuật #2] ADWIN Drift Detection → phát hiện bất thường thật sự (không phải threshold ngây thơ)
        ↓
[Kỹ thuật #1] Causal Graph (Granger causality) → xác định biến nào là nguyên nhân gốc
        ↓
[Kỹ thuật #4] Multi-Agent Debate → 2 AI tranh luận trước khi quyết định hành động
        ↓
Action thật qua MQTT (relay/actuator) + giải thích bằng lời
```

**Lý do combo này thắng:**
- Có **thuật toán thống kê thật** (ADWIN, Granger) → trả lời được câu hỏi kỹ thuật sâu từ giám khảo, không chỉ "em prompt AI"
- Có **cơ chế an toàn multi-agent** → đúng tinh thần "Intelligent Decisions", không phải AI hành động bừa
- Vẫn giữ được **phần cứng phản ứng thật** (yếu tố wow cảm xúc từ lần trước)
- Tổng thời gian code ước tính: **~4-5 tiếng** cho phần lõi kỹ thuật, còn lại dành cho tích hợp phần cứng + luyện demo

Nếu thiếu thời gian, **bỏ Digital Twin simulation (#3) trước** vì nó rủi ro cao nhất, giữ lại #1, #2, #4 vì dễ code và mỗi cái đều có "tên thuật toán cụ thể" để flex khi bị hỏi.

---

Bạn muốn tôi viết chi tiết **prompt cho từng agent** (Đề xuất/Phản biện/Trọng tài) và **code mẫu Granger causality + ADWIN** để đội bạn có sẵn khung sườn không?