# Hướng Dẫn Sử Dụng CodeBrain VS Code Extension

Tài liệu này hướng dẫn cách cài đặt, thiết lập và sử dụng CodeBrain trong VS Code để phân tích code bằng GitNexus knowledge graph và GitHub Copilot Chat.

## 1. Yêu cầu trước khi dùng

- VS Code 1.100.0 trở lên.
- GitHub Copilot đã cài đặt và đã đăng nhập.
- Node.js 20 trở lên để chạy CodeBrain/GitNexus CLI.
- Workspace nên là một Git repository.

Kiểm tra nhanh:

```powershell
node --version
git --version
```

## 2. Cài đặt extension

### Cài từ file VSIX

1. Mở VS Code.
2. Mở Extensions bằng `Ctrl+Shift+X`.
3. Chọn menu `...`.
4. Chọn `Install from VSIX...`.
5. Chọn file `codebrain-vscode.vsix`.

### Cài trong môi trường dev

1. Clone repository extension.
2. Chạy:

```powershell
npm install
npm run compile
```

3. Mở VS Code Extension Development Host bằng `F5`.

## 3. Thiết lập lần đầu

Mở Command Palette bằng `Ctrl+Shift+P`, chạy:

```text
CodeBrain: Setup
```

Lệnh này dùng để:

- Kiểm tra hoặc cài CodeBrain CLI.
- Cấu hình MCP cho GitHub Copilot.
- Tạo các file cấu hình cần thiết cho workspace.

Sau setup, chạy tiếp:

```text
CodeBrain: Analyze Active Context
```

Lệnh analyze sẽ tạo index GitNexus cho repository hoặc group đang active. Chat participant cần index này để truy vấn flow, symbol và impact.

## 4. Giao diện trong VS Code

Sau khi extension active, activity bar có mục `CodeBrain`.

### Quick Actions

- `Setup CodeBrain (MCP + Agents)`: thiết lập CLI và MCP.
- `Analyze Active Context`: phân tích repo/group đang active.
- `Force Re-index`: build lại index từ đầu.
- `Show Index Status`: xem trạng thái index.
- `Open Graph Dashboard`: mở dashboard đồ thị.
- `PR Review`: tạo prompt review PR bằng CodeBrain.

### Repos & Groups

- Chọn repository đang làm việc.
- Chọn group để làm việc với nhiều repo.
- Tạo group mới.
- Analyze từng repo hoặc cả group.

### Status Bar

Status bar hiển thị trạng thái CodeBrain:

- `Fresh`: index đang mới.
- `Stale`: code đã thay đổi so với index.
- `Not indexed`: repository chưa được analyze.
- `Indexing`: đang chạy analyze.

Click vào status bar để xem hoặc cập nhật trạng thái.

## 5. Dùng Chat Participant

Mở GitHub Copilot Chat và gõ:

```text
@CodeBrain
```

CodeBrain có các slash command:

| Command | Mục đích |
| --- | --- |
| `/explain` | Giải thích code, symbol, execution flow và dependency. |
| `/impact` | Phân tích blast radius trước khi sửa code. |
| `/debug` | Truy vết lỗi, tìm root cause và gợi ý fix nhỏ nhất. |
| `/refactor` | Hướng dẫn hoặc thực hiện refactor có kiểm tra impact. |

### Ví dụ explain

```text
@CodeBrain /explain src/ui/chat-participant.ts
Giải thích cách active GitNexus scope được đưa vào prompt.
```

Nên dùng khi muốn hiểu một flow hoặc file trước khi sửa.

### Ví dụ impact

```text
@CodeBrain /impact GitNexusAgentParticipant
Nếu đổi class này thì những phần nào bị ảnh hưởng?
```

CodeBrain sẽ ưu tiên:

- Tìm symbol mục tiêu.
- Chạy impact upstream.
- Báo cáo direct callers `d=1`.
- Cảnh báo khi risk là `HIGH` hoặc `CRITICAL`.

### Ví dụ debug

```text
@CodeBrain /debug Chat participant báo "No language model available"
```

Nên đưa thêm:

- Thông báo lỗi đầy đủ.
- File hoặc flow liên quan.
- Bước tái hiện lỗi.

### Ví dụ refactor

```text
@CodeBrain /refactor Tách logic parse instruction thành helper riêng.
```

Với refactor, CodeBrain sẽ phân tích impact trước, sau đó mới đề xuất hoặc thực hiện thay đổi bằng tool nếu request yêu cầu implement.

## 6. Làm việc với repository group

Group dùng khi bạn cần phân tích nhiều repo có liên quan.

### Tạo group

Chạy:

```text
CodeBrain: Create Repository Group
```

Sau đó chọn repo cần đưa vào group.

### Chọn group active

Chạy:

```text
CodeBrain: Select Group
```

Khi group active, chat participant sẽ đưa scope đang active vào prompt. Với GitNexus tool, repo mặc định có dạng:

```text
@ten-group
```

### Đồng bộ group

Chạy:

```text
CodeBrain: Sync Group
```

Dùng sau khi thêm, xóa repo hoặc khi contract/cross-repo relationship thay đổi.

## 7. Graph Dashboard

Mở dashboard bằng:

```text
CodeBrain: Open Graph Dashboard
```

Dashboard dùng để xem:

- Execution flow.
- Dependency graph.
- Repository metadata.
- Kết quả analyze.

Nếu dashboard không mở được, chạy:

```text
CodeBrain: Start Web UI Bridge Server
```

## 8. Workflow khuyến nghị

### Khi đọc code mới

1. Chạy `CodeBrain: Analyze Active Context`.
2. Hỏi `@CodeBrain /explain <concept/file/symbol>`.
3. Dùng follow-up để xem callers/callees hoặc flow chi tiết.

### Trước khi sửa code quan trọng

1. Hỏi `@CodeBrain /impact <symbol>`.
2. Kiểm tra direct callers `d=1`.
3. Nếu risk cao, chia nhỏ thay đổi.
4. Sau khi sửa, chạy lại analyze nếu cần.

### Khi debug

1. Mở file liên quan nếu có.
2. Hỏi `@CodeBrain /debug <symptom/error>`.
3. Yêu cầu CodeBrain trace flow và suspect symbols.
4. Chỉ apply fix nhỏ, có mục tiêu rõ ràng.

### Khi refactor

1. Dùng `/impact` hoặc `/refactor`.
2. Nếu rename symbol, CodeBrain phải preview rename trước.
3. Kiểm tra các edit confidence thấp nếu có.
4. Compile/test sau khi refactor.

## 9. Troubleshooting

### `No language model available`

- Kiểm tra GitHub Copilot đã đăng nhập.
- Mở Copilot Chat và chọn model cụ thể thay vì `auto`.
- Reload VS Code window.

### Chat không gọi được GitNexus tools

- Chạy `CodeBrain: Setup`.
- Kiểm tra file MCP trong workspace hoặc user profile.
- Reload VS Code.

### Repository chưa có kết quả

- Chạy `CodeBrain: Analyze Active Context`.
- Nếu index bị cũ, chạy `CodeBrain: Force Re-index`.
- Kiểm tra workspace có phải Git repository không.

### Group không hiện repo

- Chạy `CodeBrain: Sync Group`.
- Kiểm tra repo đã được analyze riêng lẻ chưa.
- Kiểm tra group path và registry name.

### CLI lỗi hoặc không tìm thấy

Chạy:

```text
CodeBrain: Install CodeBrain CLI
```

Nếu vẫn lỗi, xem Output panel:

```text
View: Output -> CodeBrain
```

## 10. Lệnh hay dùng

| Lệnh | Khi nào dùng |
| --- | --- |
| `CodeBrain: Setup` | Thiết lập lần đầu hoặc sửa cấu hình MCP. |
| `CodeBrain: Analyze Active Context` | Tạo/cập nhật index cho repo/group. |
| `CodeBrain: Force Re-index` | Build lại index khi kết quả sai hoặc stale. |
| `CodeBrain: Show Index Status` | Kiểm tra index có mới không. |
| `CodeBrain: Select Repository` | Đổi repo active. |
| `CodeBrain: Select Group` | Đổi group active. |
| `CodeBrain: Open Graph Dashboard` | Xem graph bằng UI. |
| `CodeBrain: PR Review with CodeBrain` | Hỗ trợ review thay đổi trong PR. |

