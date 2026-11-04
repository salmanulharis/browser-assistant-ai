"""Input sanitisation helpers: filenames, paths and sensitive-data detection."""

from __future__ import annotations

import re
import unicodedata
from pathlib import Path

from app.core.errors import ForbiddenError

_FILENAME_SAFE = re.compile(r"[^A-Za-z0-9._ -]+")
_RESERVED = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


def sanitize_filename(name: str, max_len: int = 120) -> str:
    name = unicodedata.normalize("NFKC", name or "")
    name = name.replace("\\", "/").split("/")[-1]
    name = _FILENAME_SAFE.sub("_", name).strip(" .")
    if not name:
        name = "file"
    stem, dot, ext = name.rpartition(".")
    if not dot:
        stem, ext = name, ""
    if stem.upper() in _RESERVED:
        stem = f"_{stem}"
    stem = stem[: max_len - len(ext) - 1] if ext else stem[:max_len]
    return f"{stem}.{ext}" if ext else stem


def safe_join(base: Path, *parts: str) -> Path:
    """Join paths and guarantee the result stays inside ``base``."""
    base_resolved = base.resolve()
    target = base_resolved.joinpath(*parts).resolve()
    if base_resolved != target and base_resolved not in target.parents:
        raise ForbiddenError("Path escapes the permitted directory.", code="PATH_FORBIDDEN")
    return target


# --------------------------------------------------------------------------
# Sensitive information detection (used for memory + form filling policy)
# --------------------------------------------------------------------------

SENSITIVE_FIELD_PATTERN = re.compile(
    r"pass(word|wd|code|phrase)?|pwd|\bpin\b|otp|one[- ]time|2fa|mfa|verification code|"
    r"security (code|question|answer)|cvv|cvc|csc|card ?(number|no)|credit ?card|debit ?card|"
    r"cc-?(number|csc|exp)|expir|iban|routing|account number|bank account|sort code|swift|"
    r"\bssn\b|social security|tax ?id|\bnin\b|passport|aadhaar|\bpan\b|secret|api[ _-]?key|token|"
    r"username|user ?name|login|e-?mail address for login",
    re.IGNORECASE,
)

SENSITIVE_AUTOCOMPLETE = {
    "current-password", "new-password", "one-time-code", "cc-number", "cc-csc", "cc-exp",
    "cc-exp-month", "cc-exp-year", "cc-name", "cc-type", "username", "webauthn",
}

_CARD = re.compile(r"\b(?:\d[ -]?){13,19}\b")
_SECRETISH = re.compile(
    r"(password|passwd|pwd|passcode|pin|otp|api[_ -]?key|secret|token|bearer)\s*[:=]?\s*\S+",
    re.IGNORECASE,
)
_SSN = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")
_IBAN = re.compile(r"\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b")
_LONG_TOKEN = re.compile(r"\b[A-Za-z0-9_\-]{32,}\b")


def _luhn_ok(digits: str) -> bool:
    total, alt = 0, False
    for ch in reversed(digits):
        d = int(ch)
        if alt:
            d *= 2
            if d > 9:
                d -= 9
        total += d
        alt = not alt
    return total % 10 == 0


def contains_sensitive_data(text: str) -> str | None:
    """Return a reason string if ``text`` looks like it contains secrets/payment data."""
    if not text:
        return None
    for m in _CARD.finditer(text):
        digits = re.sub(r"\D", "", m.group())
        if 13 <= len(digits) <= 19 and _luhn_ok(digits):
            return "payment card number"
    if _SECRETISH.search(text):
        return "credential or secret"
    if _SSN.search(text):
        return "national identifier"
    if _IBAN.search(text):
        return "bank account number"
    if _LONG_TOKEN.search(text):
        return "token-like string"
    return None


def is_sensitive_field(
    *,
    input_type: str | None = None,
    autocomplete: str | None = None,
    label: str | None = None,
    name: str | None = None,
    placeholder: str | None = None,
) -> str | None:
    """Return a reason if a form field must never be read or filled automatically."""
    if (input_type or "").lower() in {"password", "hidden", "file"}:
        return f"{input_type} field"
    ac = (autocomplete or "").lower().split()
    for token in ac:
        if token in SENSITIVE_AUTOCOMPLETE:
            return f"autocomplete={token}"
    hay = " ".join(x for x in (label, name, placeholder) if x)
    m = SENSITIVE_FIELD_PATTERN.search(hay)
    if m:
        return f"sensitive field ({m.group(0)})"
    return None
