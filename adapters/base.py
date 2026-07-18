"""统一数据模型 + Adapter 基类。"""
from __future__ import annotations
from dataclasses import dataclass, field, asdict
from typing import Any


@dataclass
class Part:
    type: str            # text | reasoning | tool
    text: str = ""
    tool: str = ""
    call_id: str = ""
    state: dict = field(default_factory=dict)


@dataclass
class Message:
    role: str            # user | assistant
    time: int = 0
    parts: list = field(default_factory=list)


@dataclass
class Session:
    id: str
    source: str          # claude | codex | opencode
    title: str = ""
    project: str = ""    # cwd
    model: str = ""
    agent: str = ""
    time_created: int = 0
    time_updated: int = 0
    cost: float = 0.0
    tokens: dict = field(default_factory=dict)
    message_count: int = 0

    def to_dict(self) -> dict:
        return asdict(self)


class BaseAdapter:
    source: str = ""

    def list_sessions(self, q: str = "", project: str = "",
                      limit: int = 100, offset: int = 0) -> dict:
        raise NotImplementedError

    def get_session(self, session_id: str) -> dict:
        """返回 {"session": {...}, "messages": [Message.asdict()]}"""
        raise NotImplementedError

    def get_raw(self, session_id: str) -> bytes:
        raise NotImplementedError

    def find_session_path(self, session_id: str):
        """返回会话对应的磁盘文件路径(JSONL 适配器用);opencode 这类无文件的返回 None。"""
        return None

    def delete_session_rows(self, session_id: str) -> bool:
        """无文件存储的适配器(opencode)用此方法从存储(DB)删除记录。返回是否真的删了。"""
        return False

    def open_terminal(self, session_id: str) -> None:
        """可选:打开终端恢复会话。"""
        raise NotImplementedError
