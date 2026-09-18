# Recordly MCP 연동 빠른 시작 (Windows)

AI 에이전트(Claude Code, Cursor, Codex 등)가 Recordly로 **특정 창만** 녹화하고 스크린샷을 찍게
하는 설정입니다. Node.js 설치가 필요 없습니다. 설치된 Recordly.exe가 MCP 서버를 직접 실행합니다.

## 1. 설치

`Recordly-windows-x64.exe` 설치 파일을 실행합니다. 설치 마법사에서 **"현재 사용자만"**을
고르면 `C:\Users\<사용자>\AppData\Local\Programs\Recordly` 에 설치되고, 아래 설정 파일을 그대로
쓸 수 있습니다. **"모든 사용자"**(관리자 권한)를 고르면 `C:\Program Files\Recordly` 에 설치되므로,
설정 파일의 경로를 `C:/Program Files/Recordly/Recordly.exe` 와
`C:/Program Files/Recordly/resources/mcp/recordly-mcp-server.mjs` 로 바꿔야 합니다.

## 2. MCP 등록

### 명령어 없이 파일로 등록하기 (권장)

터미널을 쓰지 않아도 됩니다. 설치 파일과 같이 받은 `claude-code.mcp.json`을
**작업 폴더**(예: 바탕화면의 `AI캡처`)에 복사하고 이름을 `.mcp.json`으로 바꿉니다.
Claude 앱의 Code 탭에서 그 폴더를 열면 "이 프로젝트의 MCP 서버를 사용할까요?" 하고 물어보니
**허용**을 누르면 끝입니다. 이 파일은 `%LOCALAPPDATA%` 변수를 쓰므로 사용자 이름을 고칠 필요가 없습니다.

Cursor는 `cursor-mcp.json` 내용을 사용합니다. Cursor 설정(Ctrl+Shift+J) → **MCP** →
**Add new MCP server** 를 누르면 `mcp.json` 파일이 열립니다. 그 안에 내용을 붙여넣고
`<사용자이름>` 두 곳을 본인 Windows 계정 이름으로 바꿔 저장합니다.

Claude 데스크톱 채팅 앱은 설정 → **개발자** → **구성 편집**을 누르면 `claude_desktop_config.json`이
열립니다. `cursor-mcp.json` 내용을 그대로 붙여넣고 저장한 뒤 앱을 다시 시작합니다.

### Claude Code (터미널이 편하면)

PowerShell 또는 터미널에서 한 줄 실행:

```bash
claude mcp add recordly -e ELECTRON_RUN_AS_NODE=1 -- "%LOCALAPPDATA%\Programs\Recordly\Recordly.exe" "%LOCALAPPDATA%\Programs\Recordly\resources\mcp\recordly-mcp-server.mjs"
```

### Cursor / Windsurf / Codex 등 (JSON 설정)

MCP 설정 파일(예: Cursor의 `mcp.json`)에 추가합니다. `<사용자>`를 실제 Windows 계정 이름으로 바꿉니다.

```json
{
	"mcpServers": {
		"recordly": {
			"command": "C:\\Users\\<사용자>\\AppData\\Local\\Programs\\Recordly\\Recordly.exe",
			"args": ["C:\\Users\\<사용자>\\AppData\\Local\\Programs\\Recordly\\resources\\mcp\\recordly-mcp-server.mjs"],
			"env": { "ELECTRON_RUN_AS_NODE": "1" }
		}
	}
}
```

## 3. 처음 한 번: Recordly를 MCP로 켜기

1. Recordly가 이미 켜져 있으면 트레이 아이콘에서 **종료**합니다.
2. 에이전트에게 "recordly_launch 실행해 줘"라고 합니다.

이때 제어 서버가 켜진 상태로 Recordly가 실행되고, 설정에 저장되어 이후에는 시작 메뉴로
평소처럼 실행해도 MCP가 붙습니다.

## 4. 에이전트에게 시키는 방법 (예시)

```text
Recordly로 Cursor 창만 녹화해 줘. 마이크는 끄고, 카운트다운 없이.
녹화가 끝나면 D:\AI캡처\cursor\90_recording_agent_flow.mp4 로 저장해 줘.
그리고 Cursor 창 스크린샷을 D:\AI캡처\cursor\01_editor_home.png 로 찍어 줘.
```

샘플처럼 **앱 화면만 1280x720, 마우스 커서 포함**으로 받는 정석 순서는 다음과 같습니다.
원본 캡처에는 커서가 없고(좌표만 따로 기록), Recordly 내보내기가 커서를 부드럽게 다시 그립니다.

```text
recordly_arrange_window name="Cursor"                     # 창을 1280x760(내용 720 + 제목표시줄 40)으로 화면 가운데에
recordly_start_recording source={"name":"Cursor","type":"window"} microphoneEnabled=false countdownSeconds=0
... 대상 앱 조작 (텍스트는 붙여넣기 대신 type 으로 한 글자씩, 대기 중엔 마우스를 화면 구석으로) ...
recordly_stop_recording
recordly_export_recording outputPath="D:\AI캡처\cursor\90_recording_agent_flow.mp4"   # cropTop 40, 여백 0, 검은 배경, 16:9, 커서 on 이 기본값
```

창을 먼저 가운데로 옮기는 이유가 하나 더 있습니다. 창 녹화는 모니터 화면을 창 영역만큼 잘라 찍기 때문에,
화면 가장자리에 그려지는 "클로드가 컴퓨터를 사용 중" 테두리가 창 위에 겹치면 그대로 찍힙니다.
가운데 1280x760이면 그 테두리 밖이라 안 들어갑니다.

Recordly 없이 원본만 빠르게 맞추려면 정지할 때 `fit`을 붙일 수도 있습니다(커서는 없음).

```text
recordly_stop_recording saveAs="D:\AI캡처\cursor\90_recording_agent_flow.mp4" fit={"width":1280,"height":720,"cropTop":40}
```

같은 제목의 창이 여러 개인 앱(예: ChatGPT 데스크톱 앱은 마스코트 오버레이 창도 "ChatGPT")은
큰 창을 자동으로 고르지만, 확실히 하려면 `recordly_list_sources`에서 본 **id**로 지정합니다.

에이전트가 내부적으로 쓰는 도구 순서:

1. `recordly_list_sources type=window` – 열려 있는 창 목록
2. `recordly_select_source name="Cursor" type=window` – 그 창만 녹화 대상으로 선택 (바탕화면·작업표시줄 제외)
3. `recordly_start_recording microphoneEnabled=false countdownSeconds=0`
4. (컴퓨터 유즈 / 브라우저 도구로 대상 앱 조작)
5. `recordly_stop_recording saveAs="D:\AI캡처\cursor\90_recording_agent_flow.mp4"`
6. `recordly_capture_screenshot name="Cursor" outputPath="D:\AI캡처\cursor\01_editor_home.png"`

## 5. 자주 겪는 문제

| 증상 | 해결 |
| --- | --- |
| `Recordly control server not found` | Recordly를 트레이에서 종료한 뒤 `recordly_launch`를 다시 실행 |
| 창 스크린샷이 실패 | 대상 창이 최소화되어 있으면 안 잡힙니다. 창을 복원한 뒤 다시 시도 |
| 녹화 정지 후 편집기가 뜸 | 정상 동작입니다. 다음 녹화는 에이전트가 자동으로 HUD로 돌아가서 시작합니다 |
| 원본 mp4가 어디 있나 | `%APPDATA%\Recordly\recordings\` (saveAs로 복사본을 원하는 위치에 저장) |

보안: 제어 서버는 이 PC 안(127.0.0.1)에서만, 실행마다 새로 만드는 토큰으로만 접근됩니다.
