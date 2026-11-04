"""Field-type handling: option matching, checkbox states, format normalisation and the policy."""

from __future__ import annotations

import pytest

from app.schemas.agent import ActionPlan, ElementInfo, PlannedAction
from app.schemas.page import FieldOption
from app.services.browser_agent import _elements_text, apply_policy
from app.services.field_values import match_option, normalize_for_input, options_prompt, to_bool

COUNTRIES = [FieldOption(value="", label="Select a country / region…")] + [
    FieldOption(value=c, label=n) for c, n in [(f"X{i:03d}", f"Filler {i}") for i in range(150)]
    + [("AX", "Åland Islands"), ("IN", "India"), ("ID", "Indonesia"), ("GB", "United Kingdom (UK)"), ("US", "United States (US)")]
]
URL = "https://shop.example/wp-admin/user-edit.php"


class TestMatchOption:
    @pytest.mark.parametrize(
        ("answer", "expected"),
        [
            ("IN", "IN"), ("India", "IN"), ("india", "IN"), (" INDIA ", "IN"),
            ("United Kingdom", "GB"), ("united kingdom (uk)", "GB"), ("Aland Islands", "AX"),
            ("", ""),  # the placeholder option
        ],
    )
    def test_maps_labels_case_accents_and_prefixes(self, answer: str, expected: str) -> None:
        assert match_option(answer, COUNTRIES) == expected

    def test_ambiguous_or_unknown_returns_none(self) -> None:
        assert match_option("United", COUNTRIES) is None  # UK and US both match
        assert match_option("Atlantis", COUNTRIES) is None
        assert match_option(None, COUNTRIES) is None
        assert match_option("x", []) is None


class TestValues:
    @pytest.mark.parametrize(("v", "b"), [("true", "true"), ("Yes", "true"), ("checked", "true"), ("on", "true"),
                                          ("false", "false"), ("No", "false"), ("unchecked", "false"), ("off", "false")])
    def test_to_bool(self, v: str, b: str) -> None:
        assert to_bool(v) == b

    def test_to_bool_unclear(self) -> None:
        assert to_bool("maybe") is None

    @pytest.mark.parametrize(
        ("t", "v", "out"),
        [
            ("date", "15 March 1995", "1995-03-15"), ("date", "1995-03-15", "1995-03-15"), ("date", "March 15, 1995", "1995-03-15"),
            ("date", "15/03/1995", "1995-03-15"), ("date", "21st June 2024", "2024-06-21"),
            ("month", "March 2024", "2024-03"), ("time", "2:30 pm", "14:30"), ("time", "9", "09:00"),
            ("datetime-local", "2024-06-01 9:05", "2024-06-01T09:05"),
            ("number", "7 years", "7"), ("number", "seven", "7"), ("number", "3,5", "3.5"), ("range", "40%", "40"),
            ("email", "meera @example.com", "meera@example.com"), ("color", "FF8800", "#ff8800"),
            ("text", "  keep me  ", "keep me"), ("date", "not a date", "not a date"),
        ],
    )
    def test_normalize_for_input(self, t: str, v: str, out: str) -> None:
        assert normalize_for_input(t, v) == out

    def test_options_prompt_shortens_long_lists_to_relevant_options(self) -> None:
        text = options_prompt(COUNTRIES, "Set the billing country to India", limit=12)
        assert "IN=India" in text and "more" in text
        assert len(text) < 400
        small = options_prompt(COUNTRIES[-3:])
        assert small == "[ID=Indonesia, GB=United Kingdom (UK), US=United States (US)]"


def _el(ref: str, **kw: object) -> ElementInfo:
    return ElementInfo(ref=ref, tag=str(kw.pop("tag", "input")), **kw)  # type: ignore[arg-type]


class TestPolicyFieldTypes:
    def _run(self, actions: list[dict[str, object]], elements: list[ElementInfo]):  # type: ignore[no-untyped-def]
        plan, blocked = apply_policy(ActionPlan(task="t", actions=[PlannedAction.model_validate(a) for a in actions]), elements, URL)
        return plan.actions, blocked

    def test_select_accepts_label_beyond_first_hundred_options(self) -> None:
        country = _el("c", tag="select", label="Country / Region", options=COUNTRIES)
        acts, blocked = self._run([{"type": "select", "target": {"ref": "c"}, "value": "India"}], [country])
        assert not blocked and acts[0].value == "IN"

    def test_fill_on_select_and_radio_becomes_select(self) -> None:
        role = _el("r", tag="select", label="Role", options=[FieldOption(value="editor", label="Editor")])
        radio = _el("m", type="radio", label="Modern", options=[FieldOption(value="fresh", label="Default"), FieldOption(value="modern", label="Modern")])
        acts, blocked = self._run([{"type": "fill", "target": {"ref": "r"}, "value": "Editor"},
                                   {"type": "fill", "target": {"ref": "m"}, "value": "modern"}], [role, radio])
        assert not blocked
        assert [(a.type, a.value) for a in acts] == [("select", "editor"), ("select", "modern")]

    def test_unknown_option_is_blocked_with_value_in_reason(self) -> None:
        role = _el("r", tag="select", label="Role", options=[FieldOption(value="editor", label="Editor")])
        _, blocked = self._run([{"type": "select", "target": {"ref": "r"}, "value": "Overlord"}], [role])
        assert "Overlord" in blocked[0]["reason"]

    def test_checkbox_click_becomes_explicit_state_and_values_normalised(self) -> None:
        on = _el("kbd", type="checkbox", label="Enable keyboard shortcuts", checked=False)
        off = _el("bar", type="checkbox", label="Show Toolbar", checked=True)
        acts, blocked = self._run([{"type": "click", "target": {"ref": "kbd"}},
                                   {"type": "fill", "target": {"ref": "bar"}, "value": "no"}], [on, off])
        assert not blocked
        assert [(a.type, a.value) for a in acts] == [("fill", "true"), ("fill", "false")]

    def test_checkbox_needs_a_clear_state(self) -> None:
        box = _el("b", type="checkbox", label="Remember me")
        _, blocked = self._run([{"type": "fill", "target": {"ref": "b"}, "value": "perhaps"}], [box])
        assert "checked/unchecked" in blocked[0]["reason"]

    def test_consent_checkboxes_are_never_ticked(self) -> None:
        terms = _el("t", type="checkbox", label="I agree to the Terms and Conditions", checked=False)
        news = _el("n", type="checkbox", label="Subscribe to our newsletter", checked=False)
        acts, blocked = self._run([{"type": "fill", "target": {"ref": "t"}, "value": "true"},
                                   {"type": "click", "target": {"ref": "n"}},
                                   {"type": "fill", "target": {"ref": "n"}, "value": "false"}], [terms, news])
        assert len(blocked) == 2 and all("tick it yourself" in b["reason"] for b in blocked)
        assert [(a.target.ref, a.value) for a in acts if a.target] == [("n", "false")]  # unticking is fine

    def test_custom_combobox_without_options_is_allowed_for_select(self) -> None:
        combo = _el("cb", tag="div", role="combobox", label="Country")
        acts, blocked = self._run([{"type": "select", "target": {"ref": "cb"}, "value": "India"}], [combo])
        assert not blocked and acts[0].value == "India"
        plain = _el("p", tag="div", label="Not a dropdown")
        _, blocked = self._run([{"type": "select", "target": {"ref": "p"}, "value": "x"}], [plain])
        assert "no options" in blocked[0]["reason"]

    def test_typed_inputs_are_normalised_for_review(self) -> None:
        dob = _el("d", type="date", label="Date of birth")
        years = _el("y", type="number", label="Years")
        acts, _ = self._run([{"type": "fill", "target": {"ref": "d"}, "value": "15 March 1995"},
                             {"type": "fill", "target": {"ref": "y"}, "value": "7 years"}], [dob, years])
        assert [a.value for a in acts] == ["1995-03-15", "7"]

    def test_prompt_lists_state_and_radio_values(self) -> None:
        text = _elements_text([
            _el("m", type="radio", label="Modern", checked=False, options=[FieldOption(value="fresh", label="Default"), FieldOption(value="modern", label="Modern")]),
            _el("k", type="checkbox", label="Keyboard shortcuts", checked=True),
            _el("c", tag="select", label="Country", options=COUNTRIES),
        ], "billing country India")
        assert 'value="modern"' in text and "UNCHECKED" in text and "CHECKED" in text
        assert "IN=India" in text and "Filler 140" not in text
