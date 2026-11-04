"""Unit tests for pure modules: security, text processing, document extraction, agent policy."""

from __future__ import annotations

import io
from pathlib import Path

import pytest

from app.core.config import EnvSettings
from app.core.errors import AppError
from app.schemas.agent import ActionPlan, ElementInfo, PlannedAction
from app.security.auth import load_or_create_token, token_matches
from app.security.sanitize import contains_sensitive_data, is_sensitive_field, safe_join, sanitize_filename
from app.services import documents
from app.services.browser_agent import apply_policy
from app.services.orchestrator import ThinkFilter, validate_citations
from app.services.text import bm25_rank, chunk_sections, estimate_tokens, normalize_text


# ------------------------------------------------------------------ security
class TestSecurity:
    def test_backend_refuses_non_loopback_bind(self) -> None:
        with pytest.raises(ValueError):
            EnvSettings(host="0.0.0.0", _env_file=None)  # type: ignore[call-arg]

    def test_wildcard_origins_are_dropped(self) -> None:
        env = EnvSettings(allowed_origins="*, chrome-extension://abc ,https://*.x.com", _env_file=None)  # type: ignore[call-arg]
        assert env.origins == ["chrome-extension://abc"]

    def test_token_is_generated_once_and_compared_safely(self, tmp_path: Path) -> None:
        p = tmp_path / "api_token"
        t1 = load_or_create_token(p)
        t2 = load_or_create_token(p)
        assert t1 == t2 and len(t1) >= 40
        assert token_matches(t1, t1)
        assert not token_matches(t1, t1[:-1] + "x")
        assert not token_matches(t1, None)

    @pytest.mark.parametrize(
        ("raw", "expected"),
        [("../../etc/passwd", "passwd"), ("C:\\Windows\\evil.pdf", "evil.pdf"), ("CON.txt", "_CON.txt"), ("  ..  ", "file"), ("a<b>:c?.docx", "a_b_c_.docx")],
    )
    def test_sanitize_filename(self, raw: str, expected: str) -> None:
        assert sanitize_filename(raw) == expected

    def test_safe_join_blocks_traversal(self, tmp_path: Path) -> None:
        assert safe_join(tmp_path, "a", "b.txt").parent.name == "a"
        with pytest.raises(AppError):
            safe_join(tmp_path, "..", "outside.txt")

    @pytest.mark.parametrize(
        "text",
        ["my card is 4111 1111 1111 1111", "password: hunter2", "api_key=EXAMPLE-not-a-real-key-0000", "IBAN DE89370400440532013000"],
    )
    def test_sensitive_data_detected(self, text: str) -> None:
        assert contains_sensitive_data(text)

    @pytest.mark.parametrize("text", ["I have 5 years of Python experience.", "My phone extension is 1234", "Order 1234 5678"])
    def test_ordinary_text_not_flagged(self, text: str) -> None:
        assert contains_sensitive_data(text) is None

    def test_sensitive_fields(self) -> None:
        assert is_sensitive_field(input_type="password")
        assert is_sensitive_field(autocomplete="cc-number")
        assert is_sensitive_field(label="Card number")
        assert is_sensitive_field(label="One-time code")
        assert is_sensitive_field(label="Years of experience") is None
        assert is_sensitive_field(label="Cover letter", name="cover_letter") is None


# ---------------------------------------------------------------------- text
class TestText:
    def test_normalize(self) -> None:
        assert normalize_text("a\u00a0 b\r\n\r\n\r\n\r\nc  ") == "a b\n\nc"

    def test_chunking_respects_size_and_overlap(self) -> None:
        paras = [f"Paragraph {i}. " + "word " * 60 for i in range(40)]
        chunks = chunk_sections([("p1", "\n\n".join(paras))], chunk_tokens=200, overlap_tokens=40)
        assert len(chunks) > 5
        assert all(c.tokens <= 260 for c in chunks), [c.tokens for c in chunks]
        assert [c.index for c in chunks] == list(range(len(chunks)))
        # overlap: the start of chunk n+1 repeats text from the end of chunk n
        assert any(chunks[i].text[-40:].split()[-1] in chunks[i + 1].text[:400] for i in range(len(chunks) - 1))
        assert chunks[0].location == "p1"

    def test_long_paragraph_is_split(self) -> None:
        big = "sentence number one. " * 800
        chunks = chunk_sections([(None, big)], chunk_tokens=150, overlap_tokens=20)
        assert len(chunks) > 5
        assert sum(estimate_tokens(c.text) for c in chunks) >= estimate_tokens(big)

    def test_bm25_prefers_relevant_doc(self) -> None:
        docs = ["The cat sat on the mat.", "Kubernetes cluster autoscaling and pods.", "Cooking pasta with garlic."]
        ranked = bm25_rank("how does kubernetes autoscaling work", docs)
        assert ranked[0][0] == 1


# ------------------------------------------------------------------- documents
class TestExtraction:
    def test_txt_and_markdown(self) -> None:
        assert documents.extract("txt", "Hello\nworld".encode())[0][1].startswith("Hello")
        md = documents.extract("md", b"# Title\n\nIntro\n\n## Section A\n\nBody A")
        joined = " ".join(t for _, t in md)
        assert "Body A" in joined and any(loc for loc, _ in md)

    def test_docx(self) -> None:
        import docx

        d = docx.Document()
        d.add_heading("Experience", 1)
        d.add_paragraph("Built a FastAPI service for invoice processing.")
        buf = io.BytesIO()
        d.save(buf)
        text = " ".join(t for _, t in documents.extract("docx", buf.getvalue()))
        assert "invoice processing" in text

    def test_pptx(self) -> None:
        from pptx import Presentation

        p = Presentation()
        s = p.slides.add_slide(p.slide_layouts[1])
        s.shapes.title.text = "Quarterly results"
        s.placeholders[1].text = "Revenue grew 12 percent"
        buf = io.BytesIO()
        p.save(buf)
        secs = documents.extract("pptx", buf.getvalue())
        assert "Revenue grew" in " ".join(t for _, t in secs)

    def test_xlsx(self) -> None:
        from openpyxl import Workbook

        wb = Workbook()
        ws = wb.active
        ws.append(["Name", "Role"])
        ws.append(["Asha", "Engineer"])
        buf = io.BytesIO()
        wb.save(buf)
        assert "Engineer" in " ".join(t for _, t in documents.extract("xlsx", buf.getvalue()))

    def test_pdf(self) -> None:
        import pymupdf

        doc = pymupdf.open()
        page = doc.new_page()
        page.insert_text((72, 72), "Local first software keeps data private.")
        data = doc.tobytes()
        assert "data private" in " ".join(t for _, t in documents.extract("pdf", data))

    def test_magic_bytes_are_checked(self) -> None:
        with pytest.raises(AppError):
            documents.extract("pdf", b"not a pdf")
        with pytest.raises(AppError):
            documents.extract("docx", b"plain text")
        with pytest.raises(AppError):
            documents.extract("txt", b"\x00\x01\x02binary" * 10)


# ------------------------------------------------------------------- policy
def _el(ref: str, **kw: object) -> ElementInfo:
    return ElementInfo(ref=ref, tag=str(kw.pop("tag", "input")), **kw)  # type: ignore[arg-type]


class TestAgentPolicy:
    URL = "https://jobs.example.com/apply"

    def test_blocks_dangerous_actions_and_keeps_safe_ones(self) -> None:
        elements = [
            _el("e1", label="Years of experience", type="text"),
            _el("e2", label="Password", type="password"),
            _el("e3", tag="button", type="submit", text="Submit application"),
            _el("e4", tag="button", type="button", text="Buy now"),
            _el("e5", tag="select", label="Country", options=[{"value": "in", "label": "India"}, {"value": "de", "label": "Germany"}]),
            _el("e6", tag="a", text="Docs", href="https://other.example.org/docs"),
        ]
        plan = ActionPlan(task="apply", actions=[
            PlannedAction(type="fill", target={"ref": "e1"}, value="5 years"),
            PlannedAction(type="fill", target={"ref": "e2"}, value="secret"),
            PlannedAction(type="click", target={"ref": "e3"}),
            PlannedAction(type="click", target={"ref": "e4"}),
            PlannedAction(type="select", target={"ref": "e5"}, value="Germany"),
            PlannedAction(type="click", target={"ref": "e6"}),
            PlannedAction(type="fill", target={"ref": "missing"}, value="x"),
            PlannedAction(type="navigate", url="javascript:alert(1)"),
            PlannedAction(type="navigate", url="https://elsewhere.example.net/"),
            PlannedAction(type="fill", target={"ref": "e1"}, value="4111 1111 1111 1111"),
        ])
        result, blocked = apply_policy(plan, elements, self.URL)
        allowed = result.actions
        kinds = [(a.type, a.target.ref if a.target else a.url) for a in allowed]
        assert ("fill", "e1") in kinds
        assert ("select", "e5") in kinds and next(a for a in allowed if a.type == "select").value == "de"
        assert len(blocked) == 6, blocked
        reasons = " | ".join(b["reason"] for b in blocked)
        assert "Sensitive field" in reasons and "submission" in reasons and "does not exist" in reasons
        assert "http(s)" in reasons and "sensitive data" in reasons
        link = next(a for a in allowed if a.target and a.target.ref == "e6")
        assert link.requires_confirmation and "leaves the site" in (link.warning or "")
        nav = next(a for a in allowed if a.type == "navigate")
        assert nav.requires_confirmation

    def test_unknown_action_type_rejected_by_schema(self) -> None:
        with pytest.raises(ValueError):
            PlannedAction.model_validate({"type": "eval", "value": "alert(1)"})
        with pytest.raises(ValueError):
            PlannedAction.model_validate({"type": "click", "script": "x"})


# -------------------------------------------------------------- orchestrator
class TestOrchestratorHelpers:
    def test_citation_validation_never_accepts_fabricated_ids(self) -> None:
        valid, invalid = validate_citations("Per [S1] and [S2], also [S9].", {"S1", "S2"})
        assert set(valid) == {"S1", "S2"} and invalid == ["S9"]

    def test_think_filter_splits_reasoning(self) -> None:
        f = ThinkFilter()
        out, think = "", ""
        for piece in ["<thi", "nk>plan", " steps</th", "ink>Answer", " here"]:
            o, t = f.feed(piece)
            out, think = out + o, think + t
        o, t = f.flush()
        out, think = out + o, think + t
        assert out.strip() == "Answer here"
        assert "plan steps" in think


# ----------------------------------------------------------- prompt budget
from app.services.browser_agent import PLAN_MAX_CLICKABLES, flag_unverified_values, select_elements  # noqa: E402


class TestPlannerPromptBudget:
    def _page(self) -> list[ElementInfo]:
        nav = [_el(f"m{i}", tag="a", text=t, href=f"https://site.example/{i}") for i, t in enumerate(
            ["Dashboard", "Posts", "Media", "Pages", "Comments", "Users", "Profile", "Tools", "Settings", "Plugins"] * 10)]
        fields = [
            _el("f1", label="First Name", name="first_name", type="text"),
            _el("f2", label="Last Name", name="last_name", type="text"),
            _el("f3", label="Billing city", name="billing_city", type="text"),
            _el("f4", label="New Password", name="pass1", type="password"),
            _el("f5", tag="select", label="Role", name="role", options=[{"value": "editor", "label": "Editor"}]),
        ]
        buttons = [_el("b1", tag="button", type="button", text="Send Reset Link"), _el("b2", tag="input", type="submit", text="Update User")]
        return nav[:50] + fields + nav[50:] + buttons

    def test_fill_task_keeps_fields_drops_navigation_and_sensitive(self) -> None:
        shown = select_elements("Fill the first name with Meera and billing city with Chennai", self._page())
        refs = [e.ref for e in shown]
        assert {"f1", "f2", "f3", "f5"} <= set(refs)
        assert "f4" not in refs  # password never shown
        assert not any(r.startswith("m") for r in refs)  # nav links irrelevant to the task
        assert refs == sorted(refs, key=[e.ref for e in self._page()].index)  # page order kept

    def test_click_task_includes_matching_controls_only(self) -> None:
        shown = [e.ref for e in select_elements("Click Send Reset Link", self._page())]
        assert "b1" in shown and len([r for r in shown if r.startswith("m")]) == 0
        many = [e.ref for e in select_elements("open the settings page", self._page())]
        assert 0 < len([r for r in many if r.startswith("m")]) <= PLAN_MAX_CLICKABLES

    def test_many_fields_are_capped_by_relevance(self) -> None:
        fields = [_el(f"x{i}", label=f"Extra field {i}", type="text") for i in range(100)] + [_el("city", label="City", type="text")]
        shown = [e.ref for e in select_elements("put Chennai in the city field", fields, limit=20)]
        assert len(shown) == 20 and "city" in shown

    def test_never_returns_empty_when_page_has_controls(self) -> None:
        links = [_el(f"l{i}", tag="a", text=f"Item {i}", href="https://a.example/") for i in range(10)]
        assert select_elements("do something unrelated", links)

    def test_unverified_contact_values_are_flagged_not_dropped(self) -> None:
        els = [_el("e", label="Email", type="email"), _el("n", label="Name", type="text"), _el("w", label="Website", type="url")]
        plan = ActionPlan(task="t", actions=[
            PlannedAction(type="fill", target={"ref": "e"}, value="made.up@example.com"),
            PlannedAction(type="fill", target={"ref": "n"}, value="Meera Iyer"),
            PlannedAction(type="fill", target={"ref": "w"}, value="https://meera.dev"),
        ])
        flag_unverified_values(plan, els, "Fill my details. <context>My site is https://meera.dev</context>")
        warn = {a.target.ref: a.warning for a in plan.actions if a.target}
        assert warn["e"] and "not found" in warn["e"]
        assert warn["n"] is None and warn["w"] is None
        assert len(plan.actions) == 3
