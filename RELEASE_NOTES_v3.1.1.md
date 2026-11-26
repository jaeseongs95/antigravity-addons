# antigravity-addons v3.1.1

## English

### Highlights
- **Chrome/Edge Private Network Access (PNA) Preflight Support (`src/runtime/main/remote-bridge-server.js`)**:
  - Responds with `Access-Control-Allow-Private-Network: true` (and `Vary: Origin, Access-Control-Request-Private-Network`) on `OPTIONS` preflights **strictly for allowlisted `Origin`s** when `Access-Control-Request-Private-Network: true` is sent. Disallowed origins continue to fail closed with HTTP `403` and zero CORS/PNA headers.
  - Prevents Chromium Private Network Access preflight rejections when `https://antigravity.google.com` connects to a same-PC `http://127.0.0.1:19384` bridge or a private-IP HTTPS reverse proxy.
- **Self-Hosted Remote Host Bridge Connection Docs (`README.md`, `README.ko.md`, `docs/REMOTE_WEB.md`, `docs/REMOTE_WEB.ko.md`)**:
  - Added concise, copy-pasteable connection examples for **Same PC**, **Home Router (Port Forwarding + DDNS + Caddy/HTTPS reverse proxy)**, **Cloudflare Tunnel**, and **Tailscale Funnel**, plus explicit Android Edge extension/Userscript support notes.

---

## 한국어

### 주요 변경 사항
- **Chrome/Edge Private Network Access(PNA) 프리플라이트 지원 (`src/runtime/main/remote-bridge-server.js`)**:
  - 허용된 `Origin`에서 `Access-Control-Request-Private-Network: true` 프리플라이트(`OPTIONS`) 요청이 올 때에만 `Access-Control-Allow-Private-Network: true` (`Vary: Origin, Access-Control-Request-Private-Network`) 헤더를 응답합니다. 미허용 오리진은 기존과 동일하게 HTTP `403` 및 CORS/PNA 헤더 미반환으로 차단합니다.
  - 최신 Chromium 브라우저에서 `https://antigravity.google.com`이 같은 PC의 `http://127.0.0.1:19384` 또는 사설망 HTTPS 리버스 프록시에 연결할 때 PNA 프리플라이트로 차단되는 문제를 예방합니다.
- **원격 호스트 브리지 셀프 호스팅 연결 예시 문서화 (`README.md`, `README.ko.md`, `docs/REMOTE_WEB.md`, `docs/REMOTE_WEB.ko.md`)**:
  - **같은 PC**, **공유기(포트포워딩 + DDNS + Caddy/HTTPS 리버스 프록시)**, **Cloudflare Tunnel**, **Tailscale Funnel** 연결 예시와 Android Edge 확장/Userscript 지원 안내를 간결하게 추가했습니다.
