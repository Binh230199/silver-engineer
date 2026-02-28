# Silver Engineer — Machine Setup Guide

Hướng dẫn setup để máy nhà và máy công ty đều work y chang nhau.

---

## Prerequisites (cả 2 máy đều cần)

| Tool | Version | Install |
|---|---|---|
| **Node.js** | 20 LTS | https://nodejs.org/en/download (chọn LTS) |
| **VS Code** | ≥ 1.95.0 | https://code.visualstudio.com |
| **Git** | any | https://git-scm.com |
| **vsce** | auto cài qua npm | `npm install -g @vscode/vsce` |

Kiểm tra:
```powershell
node --version   # v20.x.x
npm --version    # 10.x.x
code --version   # 1.95+
git --version
```

---

## Bước 1 — Đưa code lên (chỉ làm 1 lần)

### Option A: USB / ổ cứng ngoài
Copy nguyên thư mục `d:\AI\silver-engineer\` sang máy công ty.
**Bỏ qua `node_modules/`** (nặng, cài lại được):
```powershell
# Trên máy nhà — pack không có node_modules
robocopy d:\AI\silver-engineer\ E:\transfer\silver-engineer\ /E /XD node_modules dist out
```

### Option B: Git private repo (khuyến nghị)
```powershell
# Máy nhà
cd d:\AI\silver-engineer
git init
git add .
git commit -m "feat(init): initial silver-engineer extension"
git remote add origin https://your-git-server/silver-engineer.git
git push -u origin main
```
```powershell
# Máy công ty
git clone https://your-git-server/silver-engineer.git
cd silver-engineer
```

### Option C: VS Code Settings Sync
Chỉ sync được settings/extensions, KHÔNG sync được source code — dùng kết hợp với Option A/B.

---

## Bước 2 — Setup môi trường (chạy trên từng máy)

```powershell
cd path\to\silver-engineer

# Cài dependencies
npm install

# Kiểm tra TypeScript (phải báo 0 errors)
npx tsc --noEmit

# Build lần đầu (copies encoder.json + vocab.bpe vào dist/)
node esbuild.config.js

# Xác nhận dist/ có đủ file
Get-ChildItem dist | Select-Object Name
# Phải thấy: extension.js, webview.js, encoder.json, vocab.bpe
```

---

## Bước 3 — Cài extension vào VS Code

```powershell
# Build production VSIX
node esbuild.config.js --production
npx vsce package --no-dependencies --allow-missing-repository

# Cài vào VS Code
code --install-extension silver-engineer-0.1.0.vsix --force

# Reload VS Code
# Ctrl+Shift+P → "Developer: Reload Window"
```

Kiểm tra: Mở Chat (`Ctrl+Alt+I`) → gõ `@silver /summary` → thấy response là OK.

---

## Bước 4 — Cấu hình credentials (cần làm trên MỖI máy)

Credentials được lưu trong **OS keychain** (Windows Credential Manager) — KHÔNG sync qua Git.
Phải nhập lại trên từng máy.

```
Ctrl+Shift+P → "Silver Engineer: Configure API Credentials"
```

| Secret | Máy nhà | Máy công ty |
|---|---|---|
| Jira Base URL | *(bỏ qua)* | `https://company.atlassian.net` |
| Jira Email | *(bỏ qua)* | email công ty |
| Jira API Token | *(bỏ qua)* | lấy từ https://id.atlassian.com/manage-profile/security/api-tokens |
| GitHub PAT | *(tuỳ)* | thay bằng Gerrit token |

Cài VS Code settings (User scope — lưu trong `%APPDATA%\Code\User\settings.json`):
```json
{
  "silverEngineer.jiraBaseUrl": "https://company.atlassian.net",
  "silverEngineer.jiraProjectKey": "PROJ",
  "silverEngineer.enableDailyNotification": true
}
```

---

## Bước 5 — Sync VS Code Settings giữa 2 máy (tuỳ chọn)

**Dùng VS Code Settings Sync** để tự động sync settings (bao gồm `silverEngineer.*`):
```
Ctrl+Shift+P → "Settings Sync: Turn On"
→ Sign in với GitHub hoặc Microsoft account
→ Chọn sync: Settings ✅, Extensions ✅, Keybindings ✅
```

> ⚠️ Settings Sync KHÔNG sync secrets/credentials — phải nhập keychain riêng trên mỗi máy.

---

## Cấu trúc data lưu ở đâu

| Data | Location | Sync? |
|---|---|---|
| Knowledge Graph | `%APPDATA%\Code\User\globalStorage\silver-engineer.silver-engineer\knowledge-graph.json` | ❌ không tự động |
| Vector Index | `%APPDATA%\Code\User\globalStorage\silver-engineer.silver-engineer\vector-index\` | ❌ không tự động |
| Credentials | Windows Credential Manager | ❌ never |
| User Skills | `{workspace}\.vscode\silver-skills\` | ✅ qua Git |
| Extension settings | VS Code Settings Sync | ✅ nếu bật Sync |

### Sync Knowledge Graph thủ công (nếu muốn)
```powershell
# Backup từ máy nhà
$src = "$env:APPDATA\Code\User\globalStorage\silver-engineer.silver-engineer"
Copy-Item $src\knowledge-graph.json E:\backup\silver-kg.json

# Restore sang máy công ty
Copy-Item E:\backup\silver-kg.json "$env:APPDATA\Code\User\globalStorage\silver-engineer.silver-engineer\knowledge-graph.json"
```

---

## Dev Workflow hàng ngày

### Máy nhà (phát triển extension)
```powershell
cd d:\AI\silver-engineer

# Terminal 1: watch mode
node esbuild.config.js --watch

# VS Code: F5 → mở Extension Development Host
# Sửa code → Ctrl+R trong Host window để reload
```

### Máy công ty (dùng extension + tiếp tục dev)
```powershell
# Pull code mới nhất
git pull

# Cài lại deps nếu package.json thay đổi
npm install

# Build và cài
node esbuild.config.js --production
npx vsce package --no-dependencies --allow-missing-repository
code --install-extension silver-engineer-0.1.0.vsix --force
```

---

## Checklist before switching machines

### Trước khi rời máy nhà:
- [ ] `git add . && git commit -m "..." && git push`
- [ ] Backup KG nếu cần: copy `knowledge-graph.json`

### Trước khi bắt đầu ở máy công ty:
- [ ] `git pull`
- [ ] `npm install` (nếu `package.json` changed)
- [ ] `node esbuild.config.js` (build lại)
- [ ] `code --install-extension *.vsix --force` (nếu cần reinstall)
- [ ] Reload VS Code

---

## Mang tiếp với AI (GitHub Copilot / Claude)

Mở file prompt và attach vào chat:

```
#file:.github/prompts/continue-silver-engineer.prompt.md
#file:.github/skills/silver-engineer-dev/SKILL.md
```

Rồi nói:
> "Đọc 2 file trên. Tôi muốn tiếp tục phát triển extension silver-engineer. [nêu việc cần làm]"

AI sẽ có đầy đủ context về architecture, bugs đã fix, và pending work.

---

## Troubleshooting nhanh

| Triệu chứng | Lệnh debug |
|---|---|
| Extension không activate | `Ctrl+Shift+P → "Developer: Show Running Extensions"` |
| Xem log extension | `Ctrl+Shift+P → "Developer: Open Extension Logs Folder"` |
| `@silver` không xuất hiện | Kiểm tra `package.json` id = `silver-engineer.silver-engineer` |
| `encoder.json` not found | `node esbuild.config.js` (sẽ copy file) |
| MCP error | Kiểm tra `mcpServerDefinitionProviders` trong `package.json` |
| TS errors | `npx tsc --noEmit 2>&1` |
| Xem VSIX contents | `npx vsce ls` |
