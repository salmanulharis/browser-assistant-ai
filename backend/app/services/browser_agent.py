"""Browser agent planning and form-value generation.

The backend only PLANS. Plans are validated against a strict schema and a safety
policy here, then re-validated and executed by the extension after user approval.
"""

from __future__ import annotations

import json
import logging
import math
import re
from typing import Any
from urllib.parse import urlparse

from pydantic import ValidationError
from sqlalchemy import select

from app.core.context import AppContext
from app.core.errors import AppError, NotFoundError
from app.models.entities import ActionLog, BrowserTask
from app.prompts import templates
from app.schemas.agent import (
    ActionPlan,
    AgentPlanRequest,
    ElementInfo,
    FormGenerateRequest,
    ManualTaskRequest,
    PlannedAction,
    TaskResultRequest,
)
from app.schemas.chat import ContextToggles
from app.security.sanitize import contains_sensitive_data, is_sensitive_field
from app.services.capabilities import reasoning_kwargs
from app.services.field_values import CONSENT_PATTERN, match_option, normalize_for_input, options_prompt, to_bool
from app.services.ollama import ModelNotConfigured
from app.services.retrieval import ContextBuilder
from app.services.text import tokenize, truncate

log = logging.getLogger(__name__)

DANGEROUS_CLICK = re.compile(
    r"\b(submit|send|buy|pay|purchase|checkout|check out|place order|order now|confirm|delete|remove|"
    r"sign in|log ?in|sign up|register|subscribe|transfer|donate|book now|apply now|unsubscribe|"
    r"publish|post|save changes|deactivate|close account)\b",
    re.IGNORECASE,
)
NEEDS_TARGET = {"click", "type", "fill", "select", "find", "read", "highlight"}
WRITES = {"type", "fill", "select"}

def plan_schema(refs: list[str]) -> dict[str, Any]:
    """JSON schema for the planner, built per request.

    ``target.ref`` is REQUIRED and limited to the refs on the page (plus "" for actions without a
    target such as scroll/navigate). Small models otherwise tend to drop the target, which makes
    every fill unusable. Ollama enforces this schema while generating.
    """
    return {
        "type": "object",
        "properties": {
            "task": {"type": "string"},
            "actions": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "type": {
                            "type": "string",
                            "enum": ["fill", "type", "select", "click", "scroll", "find", "read", "highlight", "navigate"],
                        },
                        "target": {
                            "type": "object",
                            "properties": {"ref": {"type": "string", "enum": [*refs[:250], ""]}},
                            "required": ["ref"],
                        },
                        "value": {"type": "string"},
                        "url": {"type": "string"},
                        "direction": {"type": "string", "enum": ["up", "down", "top", "bottom"]},
                        "reason": {"type": "string"},
                    },
                    "required": ["type", "target", "reason"],
                },
            },
        },
        "required": ["task", "actions"],
    }


def _origin(url: str) -> str:
    p = urlparse(url or "")
    return f"{p.scheme}://{p.netloc}" if p.scheme and p.netloc else ""


def element_sensitivity(el: ElementInfo) -> str | None:
    return el.sensitive or is_sensitive_field(
        input_type=el.type, autocomplete=el.autocomplete, label=el.label, name=el.name, placeholder=el.placeholder
    )


def apply_policy(plan: ActionPlan, elements: list[ElementInfo], page_url: str) -> tuple[ActionPlan, list[dict[str, Any]]]:
    """Validate every action. Returns (allowed plan, blocked actions with reasons)."""
    by_ref = {e.ref: e for e in elements}
    page_origin = _origin(page_url)
    allowed: list[PlannedAction] = []
    blocked: list[dict[str, Any]] = []

    def block(a: PlannedAction, reason: str) -> None:
        blocked.append({"action": a.model_dump(exclude_none=True), "reason": reason})

    for a in plan.actions[:30]:
        el = by_ref.get(a.target.ref) if a.target and a.target.ref else None
        if a.type in NEEDS_TARGET:
            if el is None:
                block(a, "Target element does not exist on the page snapshot.")
                continue
            if el.disabled and a.type in WRITES | {"click"}:
                block(a, "Target element is disabled.")
                continue
            if a.target is not None and not a.target.label:
                a.target.label = el.label or el.text or el.name or el.placeholder
        if el is not None and a.type in WRITES and _is_button_like(el):
            name = truncate(el.label or el.text or el.name or el.type or el.tag, 60)
            block(a, f"'{name}' is a button or link, not a field – a value can't be entered into it.")
            continue
        sens = element_sensitivity(el) if el else None
        if a.type in WRITES | {"read"} and sens:
            block(a, f"Sensitive field ({sens}) – never read or filled automatically.")
            continue
        if el is not None and _is_checkbox(el) and a.type in WRITES | {"click"}:
            # Checkboxes are set to an explicit final state; a bare click would just toggle.
            if a.type == "click":
                if el.checked is not None:
                    a.type, a.value = "fill", ("false" if el.checked else "true")
            else:
                state = to_bool(a.value)
                if state is None:
                    block(a, f"“{a.value}” is not a checked/unchecked value for this checkbox.")
                    continue
                a.type, a.value = "fill", state
            label = " ".join(x for x in (el.label, el.text, el.name) if x)
            if (a.value == "true" or (a.type == "click" and not el.checked)) and CONSENT_PATTERN.search(label):
                block(a, "Agreeing to terms, consent or subscriptions is never automated – tick it yourself.")
                continue
        elif el is not None and _is_choice(el) and a.type in {"type", "fill"}:
            a.type = "select"  # a value for a dropdown or radio group is a selection
        if a.type in {"type", "fill"}:
            if a.value is None:
                block(a, "No value provided.")
                continue
            if contains_sensitive_data(a.value):
                block(a, "Value looks like sensitive data (credential/payment/ID).")
                continue
            if el is not None and el.tag == "input" and not _is_checkbox(el):
                # e.g. "15 March 1995" -> "1995-03-15" for <input type=date>; shown as-is for review.
                a.value = normalize_for_input(el.type, a.value)
        if a.type == "select":
            assert el is not None
            if not el.options:
                # Custom (non-native) dropdowns expose their options only when opened; the
                # extension opens them and picks the matching option at execution time.
                if not (_is_custom_combo(el) and (a.value or "").strip()):
                    block(a, "This element has no options to choose from.")
                    continue
            else:
                mapped = match_option(a.value, el.options)
                if mapped is None:
                    block(a, f"“{a.value}” is not one of the field's options.")
                    continue
                a.value = mapped
        if a.type == "click":
            assert el is not None
            label = " ".join(x for x in (el.label, el.text, el.name) if x)
            if el.type.lower() in {"submit", "image", "reset"} or (el.tag == "input" and el.type.lower() == "submit"):
                block(a, "Form submission is never automated. Submit the form yourself.")
                continue
            if DANGEROUS_CLICK.search(label):
                block(a, f"Clicking '{truncate(label, 60)}' could submit, purchase or change an account – do it manually.")
                continue
            if el.href:
                target_origin = _origin(el.href)
                if el.href.lower().startswith(("javascript:", "data:", "vbscript:")):
                    block(a, "Script links are not allowed.")
                    continue
                if target_origin and page_origin and target_origin != page_origin:
                    a.requires_confirmation = True
                    a.warning = f"This link leaves the site and opens {target_origin}."
        if a.type == "navigate":
            url = (a.url or "").strip()
            p = urlparse(url)
            if p.scheme not in {"http", "https"} or not p.netloc:
                block(a, "Only http(s) navigation is allowed.")
                continue
            if _origin(url) != page_origin:
                a.requires_confirmation = True
                a.warning = f"Navigates to a different site: {_origin(url)}"
        if a.type == "scroll" and not a.direction and not el:
            a.direction = "down"
        allowed.append(a)
    return ActionPlan(task=plan.task, actions=allowed), blocked


def task_to_dict(t: BrowserTask, with_logs: bool = False) -> dict[str, Any]:
    out = {
        "id": t.id,
        "task": t.task,
        "page_url": t.page_url,
        "status": t.status,
        "plan": t.plan,
        "blocked": t.blocked or [],
        "model": t.model,
        "created_at": t.created_at,
        "updated_at": t.updated_at,
        "logs": [],
    }
    if with_logs:
        out["logs"] = [
            {
                "index": lg.action_index,
                "type": lg.action_type,
                "status": lg.status,
                "message": lg.message,
                "target": lg.target,
                "created_at": lg.created_at,
            }
            for lg in sorted(t.logs, key=lambda x: (x.created_at, x.id))
        ]
    return out


# ------------------------------------------------------------ prompt budget
# Local CPU inference reads prompts at roughly 30 tokens/s, so prompt size dominates planning
# latency. A typical admin page has 100+ navigation links; the planner only needs the form
# fields plus the few controls the task actually mentions.
PLAN_MAX_ELEMENTS = 60
PLAN_MAX_CLICKABLES = 15
PLAN_SUMMARY_CHARS = 1500
PLAN_CONTEXT_CHARS = 600
PLAN_KNOWLEDGE_K = 2

FIELD_TAGS = {"input", "textarea", "select", "contenteditable"}
FIELD_ROLES = {"textbox", "searchbox", "combobox", "listbox", "checkbox", "radio", "switch", "spinbutton"}
_CLICK_INTENT = re.compile(
    r"\b(click|press|tap|open|toggle|expand|collapse|switch to|go to|navigate|visit|follow|scroll|show|"
    r"highlight|find|locate|read|button|link|menu|tab)\b",
    re.IGNORECASE,
)


# <input> types that are buttons (or uploads), not editable fields. Their ``value`` is the button
# caption, so "filling" one would overwrite the button's text.
BUTTON_INPUT_TYPES = frozenset({"submit", "button", "reset", "image", "file"})
_BUTTON_ROLES = frozenset({"button", "link", "menuitem", "tab"})


def _is_button_like(e: ElementInfo) -> bool:
    """Buttons and links: they can be clicked but never receive a value."""
    if e.tag == "input":
        return e.type.lower() in BUTTON_INPUT_TYPES
    if e.role in FIELD_ROLES or e.type == "contenteditable":
        return False  # e.g. <button role="switch"> or <button role="combobox">
    return e.tag in {"button", "a"} or e.role in _BUTTON_ROLES


def _is_field(e: ElementInfo) -> bool:
    if _is_button_like(e):
        return False
    return e.tag in FIELD_TAGS or e.role in FIELD_ROLES or e.type == "contenteditable"


def _is_checkbox(e: ElementInfo) -> bool:
    return (e.tag == "input" and e.type.lower() == "checkbox") or e.role in {"checkbox", "switch"}


def _is_choice(e: ElementInfo) -> bool:
    """Native dropdown or radio group (has a fixed option list)."""
    return e.tag == "select" or (e.tag == "input" and e.type.lower() == "radio")


def _is_custom_combo(e: ElementInfo) -> bool:
    """Script-driven dropdown (ARIA combobox/listbox) without a native <select>."""
    return e.tag != "select" and e.role in {"combobox", "listbox"}


def _descriptor_tokens(e: ElementInfo) -> set[str]:
    text = " ".join(x for x in (e.label, e.text, e.name.replace("_", " ").replace("-", " "), e.placeholder) if x)
    if e.options:
        text += " " + " ".join(o.label for o in e.options[:30])
    return set(tokenize(text))


# Words that describe the instruction rather than a specific element.
_GENERIC_TASK_WORDS = frozenset(
    "fill filled filling enter type put set write insert add change update edit replace select choose pick click "
    "press open field fields form forms box input inputs value values text page details detail info information "
    "using use mine".split()
)


def _matches(t: str, el_tokens: set[str]) -> bool:
    """Exact word or simple prefix match ("bill" ~ "billing", "names" ~ "name")."""
    return t in el_tokens or (len(t) >= 4 and any(w.startswith(t) or t.startswith(w) for w in el_tokens if len(w) >= 4))


def _relevance(task_tokens: set[str], descriptors: list[set[str]]) -> list[float]:
    """IDF-weighted overlap: words shared by many elements (e.g. "name" on 10 fields) count less
    than distinctive ones (e.g. "city")."""
    n = max(1, len(descriptors))
    weights = {t: math.log(1 + n / max(1, sum(1 for d in descriptors if _matches(t, d)))) for t in task_tokens}
    return [sum(weights[t] for t in task_tokens if _matches(t, d)) for d in descriptors]


def select_elements(task: str, elements: list[ElementInfo], limit: int = PLAN_MAX_ELEMENTS) -> list[ElementInfo]:
    """Choose the elements shown to the planner, keeping page (DOM) order.

    * Sensitive fields are never shown (the policy would block them anyway).
    * Form fields are kept – all of them when they fit, otherwise the most task-relevant ones.
    * Links/buttons are included only when they share words with the task: up to
      ``PLAN_MAX_CLICKABLES`` when the task asks to click/open/scroll, otherwise up to 5.
    """
    task_tokens = set(tokenize(task)) - _GENERIC_TASK_WORDS
    wants_click = bool(_CLICK_INTENT.search(task))
    order = {e.ref: i for i, e in enumerate(elements)}
    candidates = [e for e in elements if not element_sensitivity(e)]
    scores = _relevance(task_tokens, [_descriptor_tokens(e) for e in candidates])
    fields: list[tuple[float, ElementInfo]] = []
    clickables: list[tuple[float, ElementInfo]] = []
    for e, score in zip(candidates, scores):
        if _is_field(e):
            fields.append((score, e))
        elif score > 0:
            clickables.append((score, e))
    if len(fields) > limit:
        fields = sorted(fields, key=lambda x: (-x[0], order[x[1].ref]))[:limit]
    max_click = PLAN_MAX_CLICKABLES if wants_click else 5
    clickables = sorted(clickables, key=lambda x: (-x[0], order[x[1].ref]))[:max_click]
    chosen = [e for _, e in fields] + [e for _, e in clickables]
    if not chosen:  # nothing relevant found: let the model see the first controls rather than nothing
        chosen = [e for e in elements if not element_sensitivity(e)][:PLAN_MAX_CLICKABLES * 2]
    return sorted(chosen, key=lambda e: order[e.ref])


_CONTACT_VALUE = re.compile(r"@|https?://|www\.|^\+?[\d\s().-]{7,}$")
_CONTACT_TYPES = {"email", "tel", "url"}


def flag_unverified_values(plan: ActionPlan, elements: list[ElementInfo], evidence: str) -> None:
    """Small models sometimes invent contact details. Warn (never silently drop) when an email,
    phone or URL value appears neither in the user's request nor in the provided context."""
    by_ref = {e.ref: e for e in elements}
    hay = re.sub(r"\s+", "", evidence).lower()
    for a in plan.actions:
        if a.type not in {"fill", "type"} or not a.value:
            continue
        el = by_ref.get(a.target.ref) if a.target and a.target.ref else None
        if not ((el and el.type.lower() in _CONTACT_TYPES) or _CONTACT_VALUE.search(a.value.strip())):
            continue
        if re.sub(r"\s+", "", a.value).lower() not in hay:
            note = "This value was not found in your request or saved info - check it before applying."
            a.warning = f"{a.warning} {note}" if a.warning else note


def _elements_text(elements: list[ElementInfo], task: str = "") -> str:
    lines = []
    for e in elements[:250]:
        sens = element_sensitivity(e)
        bits = [f"ref={e.ref}", e.tag + (f"[{e.type}]" if e.type else "")]
        if e.role and e.role not in {e.tag, e.type}:
            bits.append(f"role={e.role}")
        for k, v in (("label", e.label), ("text", e.text), ("name", e.name), ("placeholder", e.placeholder)):
            if v:
                bits.append(f'{k}="{truncate(v, 80)}"')
        if e.tag == "input" and e.type.lower() == "radio" and e.options:
            # One line per radio button: its own option value (the group is chosen via "select").
            own = match_option(e.label, e.options)
            if own is not None:
                bits.append(f'value="{own}"')
        elif e.options:
            bits.append("options=" + options_prompt(e.options, f"{task} {e.label}"))
        if e.checked is not None:
            bits.append("CHECKED" if e.checked else "UNCHECKED")
        if e.href:
            bits.append(f"href={truncate(e.href, 120)}")
        if e.disabled:
            bits.append("DISABLED")
        if sens:
            bits.append("SENSITIVE-DO-NOT-TOUCH")
        lines.append(" ".join(bits))
    return "\n".join(lines)


class BrowserAgentService:
    def __init__(self, ctx: AppContext) -> None:
        self.ctx = ctx
        self.builder = ContextBuilder(ctx)

    async def _llm_json(self, model: str, system: str, user: str, schema: dict[str, Any]) -> dict[str, Any]:
        s = self.ctx.settings.get()
        client = self.ctx.ollama(s)
        last_err: Exception | None = None
        for attempt in range(2):
            kw = await reasoning_kwargs(client, model, [{"role": "system", "content": system}, {"role": "user", "content": user}], False)
            resp = await client.chat(
                model,
                kw["messages"],
                fmt=schema,
                options={"temperature": 0.1 if attempt == 0 else 0.0, "num_ctx": s.context_length},
                think=kw["think"],
            )
            try:
                data = json.loads(resp.content)
                if isinstance(data, dict):
                    return data
            except json.JSONDecodeError as exc:
                last_err = exc
        raise AppError(
            "The model did not return a valid JSON plan.",
            code="INVALID_MODEL_OUTPUT",
            status_code=502,
            hint="Try again, rephrase the task, or use a larger/more capable chat model.",
            details={"error": str(last_err)},
        )

    # ------------------------------------------------------------ planning
    async def plan(self, req: AgentPlanRequest) -> dict[str, Any]:
        s = self.ctx.settings.get()
        model = req.model or s.chat_model
        if not model:
            raise ModelNotConfigured("No chat model is configured.", hint="Choose a chat model in Settings → AI.")
        bundle = await self.builder.gather(
            req.task,
            toggles=ContextToggles(page=False, selection=False, tabs=False, history=False, samples=True,
                                   memory=req.use_memory, knowledge=req.use_knowledge),
            knowledge_k=PLAN_KNOWLEDGE_K,
            max_block_chars=PLAN_CONTEXT_CHARS,
        )
        shown = select_elements(req.task, req.elements)
        user = (
            f"Task from the user: {req.task}\n\n"
            f"Current page: {req.title} ({req.url})\n"
            + (f"Page summary (untrusted):\n<page>\n{truncate(req.page_summary, PLAN_SUMMARY_CHARS)}\n</page>\n\n" if req.page_summary else "")
            + f"Interactive elements (untrusted labels):\n<elements>\n{_elements_text(shown, req.task)}\n</elements>\n\n"
            + (bundle.render() + "\n\n" if bundle.blocks else "")
            + "Return the JSON plan."
        )
        raw = await self._llm_json(model, templates.AGENT_SYSTEM, user, plan_schema([e.ref for e in shown]))
        actions_raw = raw.get("actions") if isinstance(raw.get("actions"), list) else []
        valid: list[PlannedAction] = []
        schema_blocked: list[dict[str, Any]] = []
        for item in actions_raw:
            try:
                if isinstance(item, dict):
                    item = {k: v for k, v in item.items() if k in PlannedAction.model_fields and v not in ("", None)}
                    if item.get("type") != "scroll":
                        item.pop("direction", None)
                    if item.get("type") != "navigate":
                        item.pop("url", None)
                    if isinstance(item.get("target"), dict):
                        item["target"] = {k: v for k, v in item["target"].items() if k in {"ref", "label"} and v}
                valid.append(PlannedAction.model_validate(item))
            except ValidationError as exc:
                schema_blocked.append({"action": item if isinstance(item, dict) else {"raw": str(item)}, "reason": f"Invalid action: {exc.errors()[0]['msg']}"})
        plan = ActionPlan(task=str(raw.get("task") or req.task)[:2000], actions=valid)
        plan, blocked = apply_policy(plan, req.elements, req.url)
        flag_unverified_values(plan, req.elements, req.task + "\n" + "\n".join(bundle.blocks))
        blocked = schema_blocked + blocked
        with self.ctx.db.session() as sess:
            t = BrowserTask(
                task=req.task,
                page_url=req.url or None,
                page_origin=_origin(req.url) or None,
                status="planned",
                plan=plan.model_dump(exclude_none=True),
                blocked=blocked,
                model=model,
            )
            sess.add(t)
            sess.flush()
            for i, b in enumerate(blocked):
                sess.add(ActionLog(task_id=t.id, action_index=1000 + i, action_type=str(b["action"].get("type", "unknown"))[:32],
                                   target=b["action"].get("target"), status="blocked", message=b["reason"]))
            out = task_to_dict(t)
        out["sources"] = [x.model_dump() for x in bundle.sources]
        out["warnings"] = bundle.warnings
        return out

    def create_manual_task(self, req: ManualTaskRequest) -> dict[str, Any]:
        plan, blocked = apply_policy(ActionPlan(task=req.task, actions=req.actions[:30]), req.elements, req.url)
        with self.ctx.db.session() as sess:
            t = BrowserTask(task=req.task, page_url=req.url or None, page_origin=_origin(req.url) or None,
                            status="approved", plan=plan.model_dump(exclude_none=True), blocked=blocked, model=None)
            sess.add(t)
            sess.flush()
            return task_to_dict(t)

    def get_task(self, task_id: str) -> dict[str, Any]:
        with self.ctx.db.session() as s:
            t = s.get(BrowserTask, task_id)
            if not t:
                raise NotFoundError("Task not found.")
            return task_to_dict(t, with_logs=True)

    def list_tasks(self, limit: int = 30) -> list[dict[str, Any]]:
        with self.ctx.db.session() as s:
            rows = s.execute(select(BrowserTask).order_by(BrowserTask.created_at.desc()).limit(limit)).scalars()
            return [task_to_dict(t) for t in rows]

    def record_result(self, task_id: str, req: TaskResultRequest) -> dict[str, Any]:
        with self.ctx.db.session() as s:
            t = s.get(BrowserTask, task_id)
            if not t:
                raise NotFoundError("Task not found.")
            if t.status in {"completed", "cancelled", "failed"}:
                raise AppError(f"Task is already {t.status}.", code="TASK_FINISHED", status_code=409)
            actions = (t.plan or {}).get("actions", [])
            for r in req.results:
                a = actions[r.index] if r.index < len(actions) else {}
                s.add(ActionLog(task_id=t.id, action_index=r.index, action_type=str(a.get("type", "unknown"))[:32],
                                target=a.get("target"), status=r.status, message=r.message))
            t.status = req.status
        return self.get_task(task_id)

    # --------------------------------------------------------- form filling
    async def generate_fields(self, req: FormGenerateRequest) -> dict[str, Any]:
        s = self.ctx.settings.get()
        model = req.model or s.chat_model
        if not model:
            raise ModelNotConfigured("No chat model is configured.", hint="Choose a chat model in Settings → AI.")
        targets = set(req.target_refs) if req.target_refs else {f.ref for f in req.fields}
        skipped: list[dict[str, str]] = []
        fields = []
        for f in req.fields:
            if f.ref not in targets:
                continue
            reason = f.sensitive or is_sensitive_field(
                input_type=f.type, autocomplete=f.autocomplete, label=f.label, name=f.name, placeholder=f.placeholder
            )
            if reason:
                skipped.append({"ref": f.ref, "reason": f"Skipped: {reason}. Fill this yourself."})
                continue
            if f.type in {"submit", "button", "image", "reset", "file", "hidden"}:
                skipped.append({"ref": f.ref, "reason": f"'{f.type}' inputs are not auto-generated."})
                continue
            if f.type == "checkbox" and CONSENT_PATTERN.search(" ".join((f.label, f.name, f.nearby_text))):
                skipped.append({"ref": f.ref, "reason": "Agreeing to terms, consent or subscriptions is your decision – tick it yourself."})
                continue
            fields.append(f)
        if not fields:
            return {"suggestions": [], "skipped": skipped, "sources": [], "model": model}

        query = " ".join([req.form_heading, req.instructions] + [f.label or f.name or f.placeholder for f in fields])[:2000]
        bundle = await self.builder.gather(
            query,
            toggles=ContextToggles(page=False, selection=False, tabs=False, history=False,
                                   memory=req.use_memory, knowledge=req.use_knowledge, samples=req.use_samples),
            knowledge_k=3,
            max_block_chars=900,
        )
        # Long option lists (countries, time zones) are shortened to the options relevant to the
        # user's data; answers given as labels are mapped back by match_option().
        option_query = f"{req.instructions} {' '.join(bundle.blocks)}"[:6000]
        spec = []
        for f in fields:
            d: dict[str, Any] = {"ref": f.ref, "type": f.type or f.tag, "label": f.label or f.name or f.placeholder}
            if f.placeholder:
                d["placeholder"] = f.placeholder
            if f.required:
                d["required"] = True
            if f.max_length:
                d["max_length"] = f.max_length
            if f.type == "checkbox":
                d["options"] = ["true", "false"]
            elif f.options:
                d["options"] = options_prompt(f.options, f"{option_query} {f.label}", limit=40)
            if f.nearby_text:
                d["help_text"] = truncate(f.nearby_text, 300)
            spec.append(d)
        schema = {
            "type": "object",
            "properties": {
                "fields": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "ref": {"type": "string", "enum": [f.ref for f in fields]},
                            "value": {"type": "string"},
                            "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
                            "note": {"type": "string"},
                            "source_ids": {"type": "array", "items": {"type": "string"}},
                        },
                        "required": ["ref", "value", "confidence"],
                    },
                }
            },
            "required": ["fields"],
        }
        user = (
            f"Page: {req.title} ({req.url})\n"
            + (f"Form: {req.form_heading}\n" if req.form_heading else "")
            + (f"<form_instructions>\n{req.form_instructions}\n</form_instructions>\n" if req.form_instructions else "")
            + (f"<page>\n{truncate(req.page_summary, 3000)}\n</page>\n" if req.page_summary else "")
            + (f"User instructions (trusted): {req.instructions}\n" if req.instructions else "")
            + f"\nFields to fill:\n{json.dumps(spec, ensure_ascii=False, indent=1)}\n\n"
            + (bundle.render() if bundle.blocks else "No saved user information is available.")
            + "\n\nReturn JSON."
        )
        raw = await self._llm_json(model, templates.FORM_SYSTEM, user, schema)
        by_ref = {f.ref: f for f in fields}
        source_ids = {x.id for x in bundle.sources}
        suggestions = []
        seen: set[str] = set()
        for item in raw.get("fields", []) if isinstance(raw.get("fields"), list) else []:
            if not isinstance(item, dict):
                continue
            ref = str(item.get("ref", ""))
            f = by_ref.get(ref)
            if not f or ref in seen:
                continue
            seen.add(ref)
            value = str(item.get("value") or "").strip()
            if contains_sensitive_data(value):
                skipped.append({"ref": ref, "reason": "Generated value looked sensitive and was discarded."})
                continue
            if f.type == "checkbox":
                state = to_bool(value)
                if state is None:
                    skipped.append({"ref": ref, "reason": f"“{value}” is not a checked/unchecked answer."})
                    continue
                value = state
            elif f.options:
                mapped = match_option(value, f.options)
                if mapped is None:
                    skipped.append({"ref": ref, "reason": f"“{value}” does not match any option of this field." if value else "No matching option could be determined."})
                    continue
                value = mapped
            elif f.tag == "input":
                value = normalize_for_input(f.type, value)
            if f.max_length and len(value) > f.max_length:
                value = value[: f.max_length]
            conf = item.get("confidence") if item.get("confidence") in {"high", "medium", "low"} else "medium"
            if not value:
                conf = "low"
            suggestions.append(
                {
                    "ref": ref,
                    "value": value,
                    "confidence": conf,
                    "note": str(item.get("note") or "")[:300],
                    "source_ids": [x for x in item.get("source_ids") or [] if x in source_ids],
                }
            )
        for f in fields:
            if f.ref not in seen:
                skipped.append({"ref": f.ref, "reason": "The model returned no value for this field."})
        return {
            "suggestions": suggestions,
            "skipped": skipped,
            "sources": [x.model_dump() for x in bundle.sources],
            "model": model,
        }
