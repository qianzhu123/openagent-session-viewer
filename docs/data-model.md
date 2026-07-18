# 统一数据模型与 adapter 契约

三个 adapter 都把各自原始数据归一化成下面这套结构,前端只认这套模型,不感知来源差异。

## Session

```python
{
  "id": "ses_09648f4e",            # 原始 ID
  "source": "opencode",             # claude | codex | opencode
  "title": "审计生图实现",
  "project": "C:/Users/Light",      # 等价 cwd / 工作目录(用于按项目分组)
  "model": "gpt-5.6-sol",          # 尽量规整成字符串
  "agent": "build",                 # 可选
  "time_created": 1784093030049,   # 毫秒时间戳
  "time_updated": 1784182685479,
  "cost": 0.0,
  "tokens": {"input": 0, "output": 0, "reasoning": 0, "cache_read": 0, "cache_write": 0},
  "message_count": 0,             # 时间线条数(后端预算或前端统计)
}
```

## Timeline(单会话详情)

```python
{
  "session": {...上面 Session...},
  "messages": [
    {
      "role": "user" | "assistant",
      "time": 1784093030123,
      "parts": [
        {"type": "text", "text": "..."},
        {"type": "reasoning", "text": "..."},
        {"type": "tool", "tool": "read", "call_id": "...",
         "state": {"status": "completed", "input": {...}, "output": "..."}}
      ]
    }
  ]
}
```

### 规则

- `step-start` / `step-finish` 不进时间线(opencode 的),只用于聚合 token/cost 放到 Session 级。
- `reasoning` 部分默认折叠(前端可控),与 text 分开渲染。
- `tool.output` 超长时后端截断到 8KB,完整内容走 raw 接口。

## 三家归一化映射

| 字段 | Claude | Codex | OpenCode |
|---|---|---|---|
| id | 文件名 uuid | rollout 文件名里的 session-id | `session.id` |
| project | 文件路径解码(`-` → `\`/`/`) | `session_meta.cwd` | `session.directory` |
| title | 首条 user 消息或 summary | session_index title | `session.title` |
| model | event 内 model | session_meta model | `session.model` JSON 提取 modelID |
| messages | JSONL 行按 role 分组 | 去重 turn/user_message/agent_message | `message` JOIN `part` |
| parts | tool_use / tool_result → tool | function_call / call → tool | `part.type` 直接映射 |
| tokens | event usage | token_count 行 | `step-finish.tokens` 聚合 |

## Adapter 基类契约

每个 adapter 实现 4 个方法:

```python
class BaseAdapter:
    source: str
    def list_sessions(self, q: str, project: str, limit, offset) -> dict
    def get_session(self, session_id: str) -> dict   # Timeline
    def get_raw(self, session_id: str) -> bytes
    def open_terminal(self, session_id: str) -> None  # 可选
```

`list_sessions` 返回 `{"sessions":[...], "projects":[...], "total":N}`。
