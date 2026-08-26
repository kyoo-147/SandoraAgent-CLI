# Sandora Agent CLI

Terminal chat agent của chúng tôi, với identity hiển thị `Navin Sandora` và model label `Sandora 2.5 Computer Use`.

> **Development status:** Sandora 2.5 Computer Use sắp được cập nhật. Tên model hiện là nhãn sản phẩm; computer-use chưa bật trong MVP, nhưng coding/research tools trong workspace đã được bật.

## Architecture

Sandora hiện sử dụng **Pi agent runtime/core** làm nền tảng, không fork và không thay thế agent loop của Pi. Pi cung cấp session, streaming event lifecycle và lớp kết nối đa provider/model. UI, branding, command palette và policy chat-only là phần riêng của Sandora.

Các provider/model tương thích sẽ được mở rộng theo adapter của Pi; credential vẫn do người dùng cấu hình ở môi trường local.

## Chạy

```bash
npm install
npm start
```

Pi cần được xác thực bằng `/login` hoặc biến môi trường API key. Ví dụ:

```powershell
$env:OPENAI_API_KEY="..."
npm start
```

Có thể truyền tham số Pi:

```bash
npm start -- --model openai/gpt-5
```

## MVP hiện tại

- Full-screen terminal UI riêng của Sandora
- Chat streaming
- Header, welcome view, logo PNG truecolor và responsive resize
- Status lifecycle: connecting, thinking, typing, complete, error
- Slash command palette và research prompt commands
- Delegates up to four independent read-only subagents in parallel
- Workspace tools: đọc/tìm/sửa file, chạy PowerShell, build/test và Git
- Tự quan sát output, chẩn đoán lỗi và tiếp tục sửa trong cùng request
- Giữ session theo cơ chế của Pi

## Quyết định kiến trúc

Đây là UI/launcher riêng trên Pi runtime, không fork source Pi ở MVP. Khi UX đã được chốt, có thể chuyển thành Pi package hoặc fork có kiểm soát mà không thay agent runtime.

## License and attribution

Pi là dự án MIT: https://github.com/earendil-works/pi. Sandora UI và launcher trong repository này là phần riêng của chúng tôi.
