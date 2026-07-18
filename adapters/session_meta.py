"""会话的本地元数据层:标题别名 + 软删除(hidden)。

统一以 (source, sessionId) 为键存一份 JSON(data/session_meta.json),
不改动任何原始会话文件。前端展示时优先取别名、跳过 hidden=True 的会话。

回收站:
- claude/codex(文件存储):软删除=把 JSONL 移到 data/deleted_sessions/ 并标 hidden;
  本地删除=把 JSONL 移到系统回收站(Windows SHFileOperation,可恢复)。
- opencode(DB 存储):软删除=仅标 hidden;本地删除=从 opencode.db 删除行(不可恢复,
  因 SQLite 不进系统回收站)。本地删除前会先导出一份 JSON 备份到 data/deleted_sessions/。
"""
from __future__ import annotations
import json, os, time, shutil
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
META_PATH = DATA_DIR / "session_meta.json"
BACKUP_DIR = DATA_DIR / "deleted_sessions"
DATA_DIR.mkdir(parents=True, exist_ok=True)
BACKUP_DIR.mkdir(parents=True, exist_ok=True)


def _load() -> dict:
    if not META_PATH.exists():
        return {"sessions": {}}
    try:
        m = json.loads(META_PATH.read_text(encoding="utf-8"))
        if not isinstance(m, dict) or not isinstance(m.get("sessions"), dict):
            return {"sessions": {}}
        return m
    except Exception:
        return {"sessions": {}}


def _save(m: dict):
    META_PATH.write_text(json.dumps(m, ensure_ascii=False, indent=1), encoding="utf-8")


def _key(source: str, sid: str) -> str:
    return f"{source}::{sid}"


def get_record(source: str, sid: str) -> dict:
    return _load()["sessions"].get(_key(source, sid), {})


def save_record(source: str, sid: str, **fields):
    m = _load()
    rec = dict(m["sessions"].get(_key(source, sid), {}))
    rec.update({"source": source, "sessionId": sid,
                "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z")})
    rec.update(fields)
    m["sessions"][_key(source, sid)] = rec
    _save(m)
    return rec


def set_title_alias(source: str, sid: str, title_alias: str) -> dict:
    return save_record(source, sid, titleAlias=(title_alias or "").strip())


def hide(source: str, sid: str) -> dict:
    return save_record(source, sid, hidden=True)


def unhide(source: str, sid: str) -> dict:
    return save_record(source, sid, hidden=False)


# ---------- 回收站(Windows SHFileOperation) ----------

def _send_to_recycle_bin_windows(path_str: str) -> bool:
    """把文件/目录移到 Windows 系统回收站(可恢复)。非 Windows 回退为普通删除。"""
    if os.name != "nt":
        try:
            if os.path.isdir(path_str):
                shutil.rmtree(path_str)
            else:
                os.remove(path_str)
            return True
        except Exception:
            return False
    import ctypes
    from ctypes import wintypes

    class SHFILEOPSTRUCT(ctypes.Structure):
        _fields_ = [
            ("hwnd", wintypes.HWND),
            ("wFunc", ctypes.c_uint),
            ("pFrom", ctypes.c_wchar_p),
            ("pTo", ctypes.c_wchar_p),
            ("fFlags", wintypes.WORD),
            ("fAnyOperationsAborted", wintypes.BOOL),
            ("hNameMappings", wintypes.LPVOID),
            ("lpszProgressTitle", ctypes.c_wchar_p),
        ]

    FO_DELETE = 3
    FOF_ALLOWUNDO = 0x40
    FOF_NOCONFIRMATION = 0x10
    FOF_SILENT = 0x4
    fop = SHFILEOPSTRUCT()
    fop.hwnd = 0
    fop.wFunc = FO_DELETE
    fop.pFrom = path_str + "\0"   # pFrom 必须双 \0 结尾
    fop.pTo = None
    fop.fFlags = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT
    fop.fAnyOperationsAborted = False
    fop.hNameMappings = None
    fop.lpszProgressTitle = None
    rc = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(fop))
    return rc == 0 and not fop.fAnyOperationsAborted


def _safe_name(s: str) -> str:
    return "".join(c if c.isalnum() or c in "._-" else "_" for c in (s or "unknown"))


def soft_delete_file(source: str, sid: str, file_path: str):
    """软删除:把 JSONL 移到 data/deleted_sessions/<source>/ 备份,再标 hidden。"""
    sub = BACKUP_DIR / _safe_name(source)
    sub.mkdir(parents=True, exist_ok=True)
    backup = sub / f"{_safe_name(sid)}.{int(time.time())}.jsonl"
    shutil.move(str(file_path), str(backup))
    hide(source, sid)
    return {"method": "soft", "backupPath": str(backup)}


def hard_delete_file(source: str, sid: str, file_path: str):
    """本地删除:把 JSONL 移到系统回收站(可恢复),再标 hidden。"""
    ok = _send_to_recycle_bin_windows(str(file_path))
    if not ok:
        raise OSError("移动到回收站失败")
    hide(source, sid)
    return {"method": "recycle_bin"}


def soft_delete_db(source: str, sid: str):
    """opencode 软删除:仅标 hidden,DB 行保留。"""
    hide(source, sid)
    return {"method": "soft_db"}


def hard_delete_db(source: str, sid: str, deleter):
    """opencode 本地删除:先导出备份 JSON,再从 DB 删行。deleter=lambda sid:bool。"""
    sub = BACKUP_DIR / _safe_name(source)
    sub.mkdir(parents=True, exist_ok=True)
    backup = sub / f"{_safe_name(sid)}.{int(time.time())}.json"
    try:
        import json as _j
        from adapters.opencode import OpenCodeAdapter
        raw = OpenCodeAdapter().get_session(sid)
        backup.write_text(_j.dumps(raw, ensure_ascii=False, indent=1), encoding="utf-8")
    except Exception:
        pass
    deleted = bool(deleter(sid))
    hide(source, sid)
    return {"method": "db_delete", "deletedRows": deleted, "backupPath": str(backup)}


def list_deleted(source: str = "") -> list:
    out = []
    for key, rec in _load()["sessions"].items():
        if not rec.get("hidden"):
            continue
        if source and rec.get("source") != source:
            continue
        out.append({"source": rec.get("source", ""), "sessionId": rec.get("sessionId", ""),
                    "titleAlias": rec.get("titleAlias", ""), "updatedAt": rec.get("updatedAt", "")})
    return out


def restore(source: str, sid: str):
    """取消隐藏即可(file/db 真删的不在此职责,需在 server 端按存储类型处理文件移回)。"""
    unhide(source, sid)
    return {"restored": True}
