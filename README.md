지금까지의 대화 내용을 한 번에 복사해 .md 파일로 저장하실 수 있도록 전체 정리본을 작성했습니다. 아래 마크다운 블록 우측 상단의 복사 버튼으로 바로 저장하시면 됩니다.
```markdown
# Paseo에 커스텀(사내) Cline CLI 연결 가이드

Windows 환경에서 공식 Cline이 아닌 사내 서빙용 `cline` CLI(`--acp` 플래그 미지원, `--json` 및 `--id` 지원)를 **Paseo** 에이전트 매니저에 연동하기 위한 설정 및 Node.js ACP 어댑터 구축 기록입니다.

---

## 1. 문제 배경 및 원인 파악

* **상황:** Windows 터미널에서 `cline` 실행 시 사내 서빙 Cline TUI로 연결되며, 사내 LLM 엔드포인트 비공개 및 SSO 인증이 적용되어 있어 사내 `cline` 바이너리를 직접 호출해야 함.
* **제약 사항:** 사내 `cline --help` 확인 결과 공식 ACP 모드(`--acp`)가 제외되어 있음.
* **해결 방향:** 사내 `cline`이 지원하는 비대화형 JSON 스트리밍 옵션(`--json`, `--auto-approve`, `--cwd`, `--id`)을 호출하고, 이를 Paseo가 인식하는 표준 입출력(`stdio`) 기반 **ACP(Agent Client Protocol, JSON-RPC 2.0)** 규격으로 변환하는 중간 어댑터(`cline-sr-acp.mjs`)를 구축하여 연결.

```text
[Paseo 앱 / 데몬]  <--(ACP JSON-RPC)-->  [cline-sr-acp.mjs]  <--(CLI --json)-->  [사내 cline]

```
## 2. 사내 cline --json 출력 구조 분석
 1. **실행 및 멀티턴 이어가기:**
   * 1턴 실행: cline "<프롬프트>" --json --auto-approve
   * 출력된 최상위 "sessionId" 값을 추출하여 2턴부터 --id <sessionId> 인자로 전달하면 대화 맥락 유지 가능.
 2. **NDJSON 이벤트 구조:**
   * type: "agent_event" 내부 event 객체에 진행 상태와 데이터가 담김.
   * contentType: "text" → event.text 필드에 실제 AI 응답 텍스트 포함.
   * contentType: "reasoning" → event.reasoning 필드에 사고 과정(CoT) 텍스트 포함.
   * type: "run_result" → 턴 종료 시 반환.
## 3. ACP 어댑터 스크립트 (~/.paseo/cline-sr-acp.mjs)
%USERPROFILE%\.paseo\cline-sr-acp.mjs 경로에 아래 파일을 생성합니다.
```javascript
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const sessions = new Map();

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function sendUpdate(sessionId, update) {
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update },
  });
}

function extractPromptText(prompt) {
  if (typeof prompt === 'string') return prompt;
  if (Array.isArray(prompt)) {
    return prompt
      .map((item) => (typeof item === 'string' ? item : item?.text || ''))
      .filter(Boolean)
      .join('\n');
  }
  return prompt?.text || '';
}

function runClineTurn(acpSessionId, promptText) {
  return new Promise((resolve) => {
    const state = sessions.get(acpSessionId) || { cwd: process.cwd(), clineSessionId: null };
    const args = [promptText, '--json', '--auto-approve'];

    if (state.cwd) args.push('--cwd', state.cwd);
    if (state.clineSessionId) args.push('--id', state.clineSessionId);

    const child = spawn('cline', args, {
      cwd: state.cwd,
      shell: true,
      env: process.env,
    });

    let buffer = '';
    let hasStreamedText = false;
    let hasStreamedReasoning = false;

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const data = JSON.parse(trimmed);

          // 1턴에서 생성된 사내 cline의 실제 sessionId 저장 (2턴부터 --id로 전달)
          if (data.sessionId && !state.clineSessionId) {
            state.clineSessionId = data.sessionId;
            sessions.set(acpSessionId, state);
          }

          if (data.type === 'agent_event' && data.event) {
            const ev = data.event;
            const evType = ev.type || '';
            const cType = ev.contentType || ev.contexntType || '';

            // 1. 실제 답변 텍스트 처리
            if (cType === 'text' && typeof ev.text === 'string' && ev.text.length > 0) {
              if (evType === 'content_end' && hasStreamedText) continue;
              if (evType !== 'content_end') hasStreamedText = true;

              sendUpdate(acpSessionId, {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: ev.text },
              });
            }

            // 2. 모델 사고 과정(Reasoning) 처리 -> Paseo UI의 Thinking 영역에 표시
            if (cType === 'reasoning' && typeof ev.reasoning === 'string' && ev.reasoning.length > 0) {
              if (evType === 'content_end' && hasStreamedReasoning) continue;
              if (evType !== 'content_end') hasStreamedReasoning = true;

              sendUpdate(acpSessionId, {
                sessionUpdate: 'agent_thought_chunk',
                content: { type: 'text', text: ev.reasoning },
              });
            }

            // 3. 툴 실행 상태 표시 (파일 읽기/수정/명령 실행 등)
            if (evType.includes('tool') && (ev.name || ev.toolName)) {
              sendUpdate(acpSessionId, {
                sessionUpdate: 'tool_call',
                toolCallId: ev.toolCallId || ev.id || `tool_${Date.now()}`,
                title: ev.name || ev.toolName,
                kind: 'other',
                status: evType.includes('end') || evType.includes('result') ? 'completed' : 'in_progress',
              });
            }
          }
        } catch {
          // JSON 파싱 불가 라인 무시
        }
      }
    });

    child.stderr.on('data', (err) => {
      const msg = err.toString('utf8').trim();
      if (msg) {
        sendUpdate(acpSessionId, {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: `[stderr] ${msg}\n` },
        });
      }
    });

    child.on('close', () => {
      resolve({ stopReason: 'end_turn' });
    });

    child.on('error', (err) => {
      sendUpdate(acpSessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `실행 오류: ${err.message}` },
      });
      resolve({ stopReason: 'end_turn' });
    });
  });
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    return;
  }

  const { id, method, params } = req;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        agentInfo: { name: 'cline-sr', version: '1.0.0' },
      },
    });
  } else if (method === 'session/new') {
    const acpSessionId = `acp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    sessions.set(acpSessionId, {
      cwd: params?.cwd || process.cwd(),
      clineSessionId: null,
    });
    send({
      jsonrpc: '2.0',
      id,
      result: { sessionId: acpSessionId },
    });
  } else if (method === 'session/load') {
    const acpSessionId = params?.sessionId;
    if (!sessions.has(acpSessionId)) {
      sessions.set(acpSessionId, { cwd: params?.cwd || process.cwd(), clineSessionId: null });
    }
    send({ jsonrpc: '2.0', id, result: {} });
  } else if (method === 'session/prompt') {
    const promptText = extractPromptText(params?.prompt);
    const result = await runClineTurn(params?.sessionId, promptText);
    send({ jsonrpc: '2.0', id, result });
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, result: {} });
  }
});

```
## 4. Paseo 설정 (~/.paseo/config.json) 및 반영
 1. %USERPROFILE%\.paseo\config.json에 커스텀 ACP 프로바이더 등록 (<USERNAME>을 실제 윈도우 계정명으로 변경):
```json
{
  "agents": {
    "providers": {
      "cline-sr": {
        "extends": "acp",
        "label": "Cline SR",
        "command": ["node", "C:\\Users\\<USERNAME>\\.paseo\\cline-sr-acp.mjs"]
      }
    }
  }
}

```
 2. 설정 리로드 및 진단:
```powershell
paseo reload
paseo provider diagnostic cline-sr

```
 3. Paseo 앱에서 새 세션 생성 시 **Cline SR** 프로바이더를 선택하여 사용.
## 5. GitHub 백업 방법
민감 정보(회사명, 내부 경로, 계정명, 세션 ID 등)를 제외한 뒤 Private 리포지토리로 관리합니다.
```powershell
mkdir "$env:USERPROFILE\paseo-cline-sr-acp"
cd "$env:USERPROFILE\paseo-cline-sr-acp"

copy "$env:USERPROFILE\.paseo\cline-sr-acp.mjs" .

git init
git add .
git commit -m "feat: add ACP adapter for custom Cline CLI in Paseo"
git branch -M main
git remote add origin [https://github.com/](https://github.com/)<본인아이디>/paseo-cline-sr-acp.git
git push -u origin main

```
```

```
