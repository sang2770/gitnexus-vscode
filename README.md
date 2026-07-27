# CodeBrain - Repository-Aware AI Workflow Orchestration

**CodeBrain** là một VS Code Extension đóng vai trò như một hệ thống điều phối quy trình làm việc (workflow orchestration) AI có nhận thức về toàn bộ repository. Extension kết nối **GitHub Copilot Chat** với công cụ phân tích đồ thị **CodeGraph** và các **MCP (Model Context Protocol) Servers** để giúp AI hiểu được kiến trúc hệ thống, luồng thực thi, phân tích ảnh hưởng (impact analysis) và tạo ra các nhiệm vụ tự động hóa (Agent tasks) chuẩn xác.

Tài liệu chi tiết về kiến trúc luồng hoạt động nội bộ xem tại: [Luồng hoạt động của CodeBrain (docs/operating-flow.md)](file:///d:/me/AI/repo/gitnexus-vscode/docs/operating-flow.md)

---

## 🌟 Tính năng chính

CodeBrain cung cấp một bộ công cụ điều phối thông minh thông qua các Slash Commands (`@CodeBrain`) trong Copilot Chat:

| Command | Mục đích & Luồng Hoạt Động | Kiểu Ngữ Cảnh | Output |
| :--- | :--- | :--- | :--- |
| **`/architecture`** | Phân tích cấu trúc hệ thống, sơ đồ phân cấp thư mục và các cụm phụ thuộc (clusters). | **Full** | Sơ đồ kiến trúc (Mermaid), tổng quan module và cảnh báo rủi ro. |
| **`/explain`** | Giải thích chi tiết một symbol (class, function), luồng dữ liệu (data flow) và thứ tự chạy (runtime execution flow). | **Balanced** | Luồng xử lý chính, luồng dữ liệu, sơ đồ Mermaid. |
| **`/impact`** | Phân tích tầm ảnh hưởng (blast radius) tại độ sâu `d=1` (direct callers) và đánh giá rủi ro (risk level: High/Critical). | **Balanced** | Phân tích rủi ro, blast radius, khuyến nghị hành động. |
| **`/review`** | Đánh giá trực tiếp các thay đổi hiện tại (Git diff/PR) dựa trên đồ thị gọi hàm, phát hiện rủi ro logic và kiểm thử. | **Balanced** | Phạm vi thay đổi, phát hiện lỗi, đánh giá rủi ro và các bước xác minh. |
| **`/plan`** / **`/develop`** | Lập kế hoạch triển khai tính năng mới từ yêu cầu (bao gồm tích hợp Jira/Confluence nếu có). | **Balanced** | Phân tích giải pháp, kế hoạch triển khai chi tiết và **Copilot Agent Task**. |
| **`/fix`** | Chuẩn đoán lỗi dựa trên dấu hiệu (symptom) và đề xuất phương án sửa lỗi tối giản, an toàn cùng ca kiểm thử. | **Balanced** | Chuản đoán, phương án sửa đổi tối giản và regression tests. |
| **`/test`** / **`/verify`** | Tạo kịch bản kiểm thử (test plan) và xác minh nhanh các file bị ảnh hưởng bởi thay đổi với phạm vi nhỏ nhất. | **Compact** | Danh sách test targets, test cases chi tiết và các lệnh chạy xác minh. |
| **`/diagram`** | Tạo sơ đồ tuần tự (sequence diagram) hoặc sơ đồ luồng (flow diagram) định dạng Mermaid cho một lớp hoặc hàm. | **Balanced** | Mã Mermaid độc lập có thể xem trước. |

---

## 🛠️ Yêu cầu hệ thống (Prerequisites)

- **VS Code**: Phiên bản `1.100.0` trở lên.
- **GitHub Copilot**: Đã cài đặt extension và đăng nhập tài khoản.
- **Node.js**: Phiên bản `20` trở lên (để chạy CodeBrain CLI / CodeGraph CLI).
- **Git**: Thư mục làm việc (workspace) nên được quản lý bằng Git.

Kiểm tra nhanh môi trường:
```powershell
node --version
git --version
```

---

## 🚀 Cài đặt & Thiết lập nhanh

### 1. Cài đặt Extension
* **Từ file VSIX**: Mở màn hình Extensions (`Ctrl+Shift+X`) -> Chọn dấu ba chấm `...` góc phải -> Chọn **Install from VSIX...** -> Chọn file `codebrain-vscode.vsix`.
* **Môi trường Phát triển (Developer Mode)**:
  ```powershell
  npm install
  npm run compile
  ```
  Nhấn `F5` để mở cửa sổ *Extension Development Host* thử nghiệm.

### 2. Thiết lập (Setup & Analyze)
Mở Command Palette (`Ctrl+Shift+P` hoặc `F1`), chạy lệnh:
```text
CodeBrain: Setup
```
Lệnh này sẽ tự động:
- Kiểm tra/cài đặt CodeBrain CLI.
- Đăng ký MCP Provider cho GitHub Copilot.
- Tạo các cấu hình mặc định cho dự án.

Sau đó, tiến hành lập chỉ mục (index) mã nguồn bằng cách chạy:
```text
CodeBrain: Analyze Active Context
```
*Lưu ý: Chat Participant cần chỉ mục này để phân tích luồng và cấu trúc gọi hàm chính xác. Bạn có thể theo dõi trạng thái index trên Status Bar.*

---

## 💻 Giao diện làm việc (VS Code UI)

1. **Activity Bar Tab**: Chứa bảng điều khiển của CodeBrain:
   - **Quick Actions**: Các thao tác nhanh như Setup, Analyze, Force Re-index, Show Status, Open Graph Dashboard, PR Review.
   - **Copilot Agents**: Quản lý các Agent hỗ trợ lập trình.
2. **Status Bar Indicator**: Hiển thị độ mới (freshness) của index:
   - `Fresh`: Đồ thị chỉ mục đã đồng bộ đầy đủ với mã nguồn.
   - `Stale`: Có sự thay đổi trong code chưa được lập chỉ mục lại.
   - `Not indexed`: Thư mục chưa từng được phân tích đồ thị.
   - `Indexing`: Đang chạy ngầm quá trình phân tích đồ thị.
3. **Editor Context Menu**: Click chuột phải trong editor để gọi nhanh các workflow như *Explain Current Flow*, *Analyze Impact*, *Generate Plan*, *Generate Flow Diagram*, v.v.

---

## 🔍 Tối ưu hóa Tokens (Token Optimization)

Để tránh vượt quá dung lượng ngữ cảnh (Context Window) của LLM trong các dự án lớn, CodeBrain tự động quản lý ngân sách tokens theo 3 chế độ:
- **`compact`**: Tập trung vào ngữ cảnh cực kỳ ngắn gọn (giới hạn ~7k tokens). Phù hợp cho việc xác minh nhanh (`/verify`).
- **`balanced`**: Cân bằng giữa tệp tin thay đổi và các tệp tin gọi/được gọi trực tiếp (giới hạn ~14k tokens). Phù hợp cho giải thích, tác động, lập kế hoạch.
- **`full`**: Lấy toàn bộ kiến trúc xung quanh và các mối quan hệ đồ thị sâu hơn (giới hạn ~22k tokens). Phù hợp cho phân tích kiến trúc tổng thể (`/architecture`).

Bạn có thể thay đổi chế độ mặc định bằng cách chạy lệnh:
```text
CodeBrain: Set Token Optimization Mode
```

---

## 📚 Tài liệu tham khảo

- [Hướng dẫn sử dụng chi tiết (docs/HDSD.md)](file:///d:/me/AI/repo/gitnexus-vscode/docs/HDSD.md)
- [Quy trình hoạt động chi tiết (docs/operating-flow.md)](file:///d:/me/AI/repo/gitnexus-vscode/docs/operating-flow.md)
- [Đặc tả Workflow CodeBrain v2 (docs/codebrain-v2-workflows.md)](file:///d:/me/AI/repo/gitnexus-vscode/docs/codebrain-v2-workflows.md)
