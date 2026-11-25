맨 아래에 붙이는 게 아니라 기존 initialize, session/new, session/prompt 분기를 교체해야 하므로, 헷갈리지 않도록 전체 완성본(cline-sr-acp.mjs)을 바로 드립니다.
C:/Users/<본인윈도우계정명>/.paseo/cline-sr-acp.mjs 파일 내용을 아래 코드로 통째로 덮어쓰세요.
```javascript
import { spawn } from 'node:child_process';
import readline from 'node:readline';

// 사내에서 사용하는 모델 ID 목록 (필요 시 실제 모델 ID로 항목 추가)
const AVAILABLE_MODELS = [
  { id: 'default', name: 'Default (Cline SR)' },
];

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
    const state = sessions.get(acpSessionId) || {
      cwd: process.cwd(),
      clineSessionId: null,
      model: null,
    };
    const args = [promptText, '--json', '--auto-approve'];

    if (state.cwd) args.push('--cwd', state.cwd);
    if (state.clineSessionId) args.push('--id', state.clineSessionId);
    if (state.model && state.model !== 'default') {
      args.push('--model', state.model);
    }

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

            // 3. 툴 실행 상태 표시
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
        models: AVAILABLE_MODELS,
      },
    });
  } else if (method === 'session/new') {
    const acpSessionId = `acp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    sessions.set(acpSessionId, {
      cwd: params?.cwd || process.cwd(),
      clineSessionId: null,
      model: params?.model || null,
    });
    send({
      jsonrpc: '2.0',
      id,
      result: {
        sessionId: acpSessionId,
        models: AVAILABLE_MODELS,
      },
    });
  } else if (method === 'session/load') {
    const acpSessionId = params?.sessionId;
    if (!sessions.has(acpSessionId)) {
      sessions.set(acpSessionId, {
        cwd: params?.cwd || process.cwd(),
        clineSessionId: null,
        model: params?.model || null,
      });
    }
    send({ jsonrpc: '2.0', id, result: {} });
  } else if (method === 'session/prompt') {
    const state = sessions.get(params?.sessionId);
    if (state && params?.model) {
      state.model = params.model;
    }
    const promptText = extractPromptText(params?.prompt);
    const result = await runClineTurn(params?.sessionId, promptText);
    send({ jsonrpc: '2.0', id, result });
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, result: {} });
  }
});

```
저장 후 터미널에서 paseo reload를 실행하면 Paseo 앱의 모델 목록에 Default (Cline SR)이 나타납니다. 사내에서 쓰는 특정 모델 ID가 있다면 상단 AVAILABLE_MODELS 배열에 추가해 쓰시면 됩니다!
