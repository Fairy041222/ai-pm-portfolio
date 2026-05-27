from cryptography.fernet import Fernet, InvalidToken

from app.config import get_settings


def _get_fernet() -> Fernet | None:
    key = get_settings().encryption_key.strip()
    if not key:
        return None
    try:
        return Fernet(key.encode() if isinstance(key, str) else key)
    except Exception:
        return None


def encrypt_api_key(plain: str) -> str | None:
    if not plain:
        return None
    f = _get_fernet()
    if not f:
        return plain
    return f.encrypt(plain.encode()).decode()


def decrypt_api_key(encrypted: str | None) -> str | None:
    if not encrypted:
        return None
    f = _get_fernet()
    if not f:
        return encrypted
    try:
        return f.decrypt(encrypted.encode()).decode()
    except InvalidToken:
        # 兼容 ENCRYPTION_KEY 变更前明文存储的数据
        return encrypted


def mask_api_key(plain: str | None) -> str | None:
    """返回可展示给前端的掩码，不包含完整明文。"""
    if not plain:
        return None
    key = plain.strip()
    if not key:
        return None
    if len(key) <= 6:
        return "****"
    prefix_len = min(7, max(3, key.find("-") + 1 if "-" in key[:8] else 3))
    prefix = key[:prefix_len]
    suffix = key[-3:] if len(key) > prefix_len + 3 else ""
    if suffix and prefix_len + len(suffix) < len(key):
        return f"{prefix}****{suffix}"
    return f"{prefix}****"
