"""会话标题写回:把标题直接写进 Claude jsonl,让终端 claude -r 与后台一致。

为什么 append-only:CLI 对活跃会话持内存态、退出/每轮会整体写回或追加,
就地改写历史行会被内存写回覆盖(同 DouAi 改 xml 的坑);而往文件末尾追加
一条 ai-title 事件与 CLI 自身的写入方式同构,对活跃会话也安全。

CLI 取标题规则为「文件中最后一条 ai-title」(本模块附带验证过的行为),
所以追加即生效,无需删除任何历史行。标题含代理名污染对(agent-name 紧跟
ai-title)时,列表侧 adapters/claude.py 已跳过,不影响展示。
"""
from __future__ import annotations
import json, os, time


def write_title(path: str, title: str) -> dict:
    """往 jsonl 末尾追加一条 ai-title 事件。返回写入前后的字节数供校验。"""
    title = (title or "").strip()
    if not title:
        raise ValueError("标题不能为空")
    if not os.path.isfile(path):
        raise FileNotFoundError(path)
    before = os.path.getsize(path)
    ev = {"type": "ai-title", "aiTitle": title,
          "sessionId": os.path.splitext(os.path.basename(path))[0]}
    line = json.dumps(ev, ensure_ascii=False)
    with open(path, "a", encoding="utf-8", newline="\n") as f:
        f.write(line + "\n")
        f.flush()
        os.fsync(f.fileno())
    after = os.path.getsize(path)
    return {"written": title, "bytesBefore": before, "bytesAfter": after,
            "appendedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z")}


def read_last_clean_title(path: str) -> str:
    """读最后一条干净 ai-title(与 adapters/claude.py 同判定,供前端回显)。"""
    from .claude import ClaudeAdapter
    return ClaudeAdapter()._session_title(path)["title"]
