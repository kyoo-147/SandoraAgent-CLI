# Sandora Agent CLI

![Giao diện Sandora Agent CLI](assets/sandora-agent-cli.png)

**Sandora Agent CLI** là trợ lý lập trình và nghiên cứu tự động chạy trong terminal, được xây dựng trên Pi agent runtime. Giao diện hiển thị thương hiệu **Navin Sandora** và model label **Sandora 2.5 9B Computer Use**.

## Trạng thái phát triển

Sandora hiện là MVP đang được phát triển tích cực. Các chức năng coding/research trong workspace đã hoạt động, bao gồm đọc và chỉnh sửa mã nguồn, chạy lệnh, build, test, Git và điều phối subagent.

Model **Sandora 2.5 9B Computer Use** đang được chúng tôi thử nghiệm riêng tư và chưa phát hành công khai. Nếu bạn muốn tham gia thử nghiệm sớm, vui lòng liên hệ đội ngũ dự án hoặc mở một GitHub Issue với tiêu đề `Private Model Access` và mô tả ngắn nhu cầu sử dụng.

> Tên model hiện là nhãn sản phẩm. Browser/computer-use trực tiếp chưa được bật trong bản MVP công khai này.

## Khả năng hiện tại

- Hiểu và khảo sát codebase trong workspace hiện tại
- Đọc, tìm kiếm, tạo, chỉnh sửa và xóa file
- Chạy PowerShell, build, test và các lệnh phát triển thông thường
- Quan sát output, chẩn đoán lỗi và tiếp tục sửa chữa
- Kiểm tra Git status, diff, history và branch
- Commit, push và hỗ trợ quy trình pull request khi được yêu cầu
- Điều phối tối đa bốn subagent read-only độc lập chạy song song
- Duy trì session và context qua Pi runtime
- Hiển thị rõ trạng thái `THINKING`, `RUNNING`, `TYPING`, `ABORTING` và `COMPLETE`

## Kiến trúc

Sandora sử dụng **Pi agent runtime/core** thay vì tự xây dựng lại agent loop. Pi đảm nhiệm:

- session và context lifecycle
- model/provider abstraction
- streaming event lifecycle
- filesystem, search, shell và tool execution
- cơ chế mở rộng tool/provider về sau

Sandora cung cấp giao diện terminal, branding, command palette, trạng thái hoạt động, policy workspace và lớp điều phối subagent riêng.

## Hỗ trợ nhiều provider

Sandora không bị khóa vào model riêng của chúng tôi. Nhờ lớp provider của Pi, CLI có thể hoạt động với các model/provider tương thích mà Pi hỗ trợ, tùy theo credential và cấu hình trên máy người dùng.

Điều này phù hợp cho cả hai trường hợp:

1. Sử dụng model Sandora riêng tư khi được cấp quyền thử nghiệm.
2. Sử dụng provider khác đã được cấu hình trong Pi để chạy Sandora UI và agent workflow.

Credential luôn được giữ trong môi trường local của người dùng; repository này không chứa API key.

## Cài đặt và chạy

Yêu cầu Node.js và npm.

```bash
npm install
npm start
```

Trước khi chạy, hãy cấu hình hoặc xác thực provider trong Pi, hoặc cung cấp API key bằng biến môi trường tương ứng với provider bạn sử dụng.

Ví dụ với biến môi trường:

```powershell
$env:OPENAI_API_KEY="..."
npm start
```

## Slash commands

Nhập `/` trong giao diện để xem và tự động hoàn thành command.

Một số command chính:

```text
/help       xem hướng dẫn
/tools      xem capability đang bật
/status     xem trạng thái agent và model
/session    xem session và workspace
/clear      xóa nội dung hiển thị
/quit       thoát Sandora
```

Ngoài ra còn có các command hỗ trợ giải thích, so sánh, evidence review, research brief, challenge, tóm tắt và dịch thuật.

## An toàn workspace

Sandora được phép thực hiện công việc phát triển thông thường trong workspace được chọn. Agent được hướng dẫn:

- không truy cập hoặc xóa dữ liệu không liên quan bên ngoài workspace
- không làm lộ credential
- không chạy lệnh hệ thống phá hoại
- không ghi đè thay đổi không liên quan của người dùng
- kiểm tra diff và test trước khi commit, push hoặc tạo pull request

Subagent hiện chỉ có các tool đọc/tìm kiếm được giới hạn trong workspace. Parent agent chịu trách nhiệm tích hợp, chỉnh sửa, test và Git delivery.

## Kiểm tra

```bash
npm run check
npm test
```

## Giới hạn MVP

- Browser/computer-use chưa được bật trong bản công khai
- Model Sandora 2.5 9B Computer Use vẫn đang thử nghiệm riêng tư
- Subagent được giới hạn read-only; parent agent thực hiện thay đổi
- Sandbox của worker là application-level, chưa phải OS container
- Chưa có GitHub Actions CI mặc định trong repository

## Pi runtime và ghi nhận

Sandora Agent CLI sử dụng Pi agent runtime/core làm nền tảng. Pi là dự án mã nguồn mở theo giấy phép MIT:

https://github.com/earendil-works/pi

Giao diện, branding, launcher và các tích hợp Sandora trong repository này là phần riêng của dự án Sandora.
