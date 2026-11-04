"""Field-value helpers shared by the planner and the form generator.

Small local models often answer with an option's *label* ("India") instead of its value ("IN"),
change capitalisation, or use free-form dates/numbers. These helpers map model output onto what
the page actually accepts. They are mirrored in ``extension/lib/field-values.ts``, which applies
the same rules at execution time.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable
from datetime import datetime
from typing import Protocol

from app.services.text import tokenize


class OptionLike(Protocol):
    value: str
    label: str


_PUNCT = re.compile(r"[^\w\s]", re.UNICODE)
_WS = re.compile(r"\s+")


def _norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(ch for ch in s if not unicodedata.combining(ch))  # "Åland" -> "Aland"
    return _WS.sub(" ", _PUNCT.sub(" ", s.casefold())).strip()


def match_option(value: str | None, options: Iterable[OptionLike]) -> str | None:
    """Return the option VALUE that ``value`` refers to, or None when it is ambiguous/unknown.

    Order: exact value → exact label → case/accent/punctuation-insensitive value or label →
    a unique option whose label starts with / contains the answer (or vice versa).
    """
    opts = [o for o in options]
    if value is None or not opts:
        return None
    raw = str(value).strip()
    for o in opts:
        if o.value == raw:
            return o.value
    for o in opts:
        if o.label.strip() == raw:
            return o.value
    n = _norm(raw)
    if not n:
        # An empty answer may legitimately select an option whose value is "" (e.g. "English").
        return next((o.value for o in opts if o.value == ""), None)
    exact = [o for o in opts if _norm(o.value) == n or _norm(o.label) == n]
    if len(exact) >= 1:
        return exact[0].value
    prefix = [o for o in opts if _norm(o.label).startswith(n) or (len(n) >= 3 and n.startswith(_norm(o.label)) and _norm(o.label))]
    if len(prefix) == 1:
        return prefix[0].value
    contains = [o for o in opts if n in _norm(o.label) or (len(_norm(o.label)) >= 3 and _norm(o.label) in n)]
    if len(contains) == 1:
        return contains[0].value
    return None


_TRUE = {"true", "yes", "y", "on", "1", "checked", "check", "tick", "ticked", "enable", "enabled", "select", "selected", "agree"}
_FALSE = {"false", "no", "n", "off", "0", "unchecked", "uncheck", "untick", "unticked", "disable", "disabled", "deselect", "unselected", "clear", ""}


def to_bool(value: str | None) -> str | None:
    """Normalise a checkbox answer to "true"/"false" (None when unclear)."""
    v = _norm(str(value if value is not None else ""))
    if v in _TRUE:
        return "true"
    if v in _FALSE:
        return "false"
    return None


# Agreeing to terms/consent or subscribing is a decision the user must make themselves.
CONSENT_PATTERN = re.compile(
    r"\b(agree|accept|consent|terms|conditions|privacy|policy|gdpr|newsletter|subscribe|marketing|"
    r"opt[ -]?in|i have read|i confirm|i certify|authori[sz]e)\b",
    re.IGNORECASE,
)

_DATE_FORMATS = ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%d.%m.%Y", "%m/%d/%Y", "%d %B %Y", "%d %b %Y", "%B %d %Y",
                 "%b %d %Y", "%B %d, %Y", "%b %d, %Y", "%d %B, %Y", "%Y/%m/%d")
_NUMBER = re.compile(r"-?\d+(?:[.,]\d+)?")
_WORD_NUMBERS = {w: i for i, w in enumerate(
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen "
    "seventeen eighteen nineteen twenty".split())}


def _parse_date(v: str) -> datetime | None:
    s = re.sub(r"(\d)(st|nd|rd|th)\b", r"\1", v.strip())
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def normalize_for_input(input_type: str, value: str) -> str:
    """Convert a value into the format a native input of ``input_type`` accepts.

    Returns the value unchanged when no conversion applies; the extension verifies the result
    after inserting it and reports a clear error if the browser still rejects it.
    """
    t = (input_type or "").lower()
    v = (value or "").strip()
    if not v:
        return v
    if t == "date":
        d = _parse_date(v)
        return d.strftime("%Y-%m-%d") if d else v
    if t == "month":
        d = _parse_date(v) or _parse_date(f"1 {v}")
        return d.strftime("%Y-%m") if d else v
    if t == "datetime-local":
        m = re.match(r"^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2})", v)
        return f"{m.group(1)}T{m.group(2).zfill(5)}" if m else v
    if t == "time":
        m = re.match(r"^(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?$", v, re.IGNORECASE)
        if m:
            h, mi, ap = int(m.group(1)), int(m.group(2) or 0), (m.group(3) or "").lower()
            if ap.startswith("p") and h < 12:
                h += 12
            if ap.startswith("a") and h == 12:
                h = 0
            if 0 <= h < 24 and 0 <= mi < 60:
                return f"{h:02d}:{mi:02d}"
        return v
    if t in {"number", "range"}:
        m = _NUMBER.search(v)
        if m:
            return m.group().replace(",", ".")
        word = _norm(v).split(" ")[0] if _norm(v) else ""
        return str(_WORD_NUMBERS[word]) if word in _WORD_NUMBERS else v
    if t == "email":
        return v.replace(" ", "")
    if t == "color":
        m = re.fullmatch(r"#?([0-9a-fA-F]{6})", v)
        return f"#{m.group(1).lower()}" if m else v
    return v


def options_prompt(options: list[OptionLike], query: str = "", limit: int = 25) -> str:
    """Compact option listing for a prompt.

    Shows ``value`` alone when it equals the label, else ``value=label``. Long lists are reduced to
    the options most relevant to ``query`` plus the first few, with a count of the rest – the
    model may answer with any option label, which ``match_option`` maps back to its value.
    """
    if not options:
        return ""

    def fmt(o: OptionLike) -> str:
        label = o.label.strip()
        if not label or label == o.value:
            return o.value or '""'
        return f"{o.value or chr(34) * 2}={label}"

    if len(options) <= limit:
        return "[" + ", ".join(fmt(o) for o in options) + "]"
    q = set(tokenize(query))
    relevant = [o for o in options if q and (q & set(tokenize(f"{o.label} {o.value}")))]
    picked: list[OptionLike] = []
    for o in relevant[: limit - 5] + options:
        if o not in picked:
            picked.append(o)
        if len(picked) >= limit:
            break
    return "[" + ", ".join(fmt(o) for o in picked) + f", … +{len(options) - len(picked)} more (answer with the label)]"
