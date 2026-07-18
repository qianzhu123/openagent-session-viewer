# OpenAgent Session Viewer

一个本地 Web 界面,统一浏览三个智能体 CLI 的本地会话记录:

- **Claude Code** — `C:\Users\Light\.claude\projects\**\*.jsonl`
- **Codex** — `C:\Users\Light\.codex\sessions\YYYY\MM\DD\rollout-*.jsonl`
- **OpenCode** — `C:\Users\Light\.local\share\opencode\opencode.db`(SQLite)

## 设计目标

- **只读**:对三家数据来源不删、不改、不重写原始文件。
- **统一入口**:一个首页,顶部切换 source(claude / codex / opencode),左侧会话列表,右侧时间线。
- **信息架构对齐** `claude-session-viewer` 与 `codex-session-viewer`:Python 单文件 `server.py` + `static/`(index.html / app.js / style.css) + `docs/`,刷新安全 URL `/session/<source>/<id>`。

## 快速开始

```bash
cd D:/code/myweb/openagent-session-viewer
python server.py --open
# http://127.0.0.1:8092
```

## 与已有两个 viewer 的关系

本项目在同一 `D:\code\myweb` 目录下,但**独立运行**,不依赖另两个项目。后端解析逻辑拆成 3 个 adapter(见下),Codex adapter 的清洗规则参考 `codex-session-viewer`。

## 目录结构

```text
openagent-session-viewer/
  server.py              本地 HTTP/API 服务器 + adapter 调度
  start.vbs              双击启动器(待补)
  adapters/
    base.py              统一数据模型 + Adapter 基类
    claude.py            扫描 .claude/projects JSONL
    codex.py             扫描 .codex/sessions JSONL
    opencode.py          读 opencode.db SQLite
  static/                浏览器 UI
    index.html
    app.js
    style.css
  docs/
    API.md
    data-model.md        三家数据源归一化映射表
  data/                  本地查看器缓存(session_index.json)
  tests/
    smoke_test.py
```

## 三家数据源对比

| 来源 | 路径 | 格式 | 标题来源 |
|---|---|---|---|
| Claude | `.claude/projects/<编码路径>/*.jsonl` | JSONL | 首条 user 消息 / summary |
| Codex | `.codex/sessions/**/rollout-*.jsonl` | JSONL | `session_index.jsonl` / session_meta |
| OpenCode | `.local/share/opencode/opencode.db` | SQLite | `session.title` |

## API

见 `docs/API.md`。
