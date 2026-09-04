"""Shared Anki model definitions for lecture-rip (genanki + native Collection)."""

from __future__ import annotations

import json
import zlib
from typing import Any

import genanki

MODEL_MC_NAME = "JKU MC"
BASIC_MODEL_NAME = "Basic"
CLOZE_MODEL_NAME = "Cloze"


def deterministic_id(name: str) -> int:
    """Stable positive int from name — idempotent model/deck re-creation."""
    return zlib.crc32(name.encode("utf-8")) & 0x7FFFFFFF


def mc_model_id() -> int:
    return deterministic_id("lecture-rip:model:JKU MC")


def basic_model_id() -> int:
    return deterministic_id("lecture-rip:model:Basic")


def cloze_model_id() -> int:
    return deterministic_id("lecture-rip:model:Cloze")


MC_CSS = """
.card {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 18px;
  color: #1a1a1a;
  background: #fafafa;
  padding: 16px;
  max-width: 720px;
  margin: 0 auto;
}
.mc-question {
  font-size: 1.15em;
  font-weight: 600;
  margin-bottom: 1em;
  line-height: 1.4;
}
.mc-options { margin: 0.5em 0 1em; }
.mc-option {
  display: block;
  width: 100%;
  text-align: left;
  padding: 10px 14px;
  margin: 8px 0;
  border: 2px solid #bdbdbd;
  border-radius: 8px;
  background: #fff;
  cursor: pointer;
  font-size: 1em;
  line-height: 1.3;
  transition: border-color 0.15s, background 0.15s;
}
.mc-option:hover:not(.mc-disabled) { border-color: #616161; }
.mc-option.mc-correct { border-color: #2e7d32; background: #e8f5e9; }
.mc-option.mc-wrong { border-color: #c62828; background: #ffebee; }
.mc-option.mc-disabled { cursor: default; opacity: 0.85; }
.mc-explanation {
  margin-top: 1em;
  padding: 12px 14px;
  background: #eeeeee;
  border-radius: 8px;
  border-left: 4px solid #1565c0;
  display: none;
  line-height: 1.4;
}
.mc-explanation.mc-show { display: block; }
"""

MC_FRONT = """
<div class="mc-card">
  <div class="mc-question">{{Question}}</div>
  <div id="mc-opts-data" style="display:none">{{Options JSON}}</div>
  <div class="mc-options" id="mc-opts"></div>
  <div class="mc-explanation" id="mc-exp">{{Explanation}}</div>
</div>
<script>
(function() {
  var dataEl = document.getElementById('mc-opts-data');
  var container = document.getElementById('mc-opts');
  var exp = document.getElementById('mc-exp');
  if (!dataEl || !container) return;

  var options;
  try {
    options = JSON.parse(dataEl.textContent || '[]');
  } catch (e) {
    return;
  }
  var correct = parseInt({{Correct}}, 10);
  if (!Array.isArray(options)) return;

  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  var indexed = options.map(function(text, idx) { return { text: text, idx: idx }; });
  shuffle(indexed);

  indexed.forEach(function(item) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mc-option';
    btn.textContent = item.text;
    btn.addEventListener('click', function() {
      var buttons = container.querySelectorAll('.mc-option');
      buttons.forEach(function(b) { b.classList.add('mc-disabled'); b.disabled = true; });
      if (item.idx === correct) {
        btn.classList.add('mc-correct');
      } else {
        btn.classList.add('mc-wrong');
        buttons.forEach(function(b, i) {
          if (indexed[i].idx === correct) b.classList.add('mc-correct');
        });
      }
      if (exp) exp.classList.add('mc-show');
    });
    container.appendChild(btn);
  });
})();
</script>
"""

MC_BACK = """
<div class="mc-card">
  <div class="mc-question">{{Question}}</div>
  <div class="mc-explanation mc-show">{{Explanation}}</div>
</div>
"""


def get_genanki_mc_model() -> genanki.Model:
    return genanki.Model(
        mc_model_id(),
        MODEL_MC_NAME,
        fields=[
            {"name": "Question"},
            {"name": "Options JSON"},
            {"name": "Correct"},
            {"name": "Explanation"},
        ],
        templates=[
            {"name": "MC", "qfmt": MC_FRONT, "afmt": MC_BACK},
        ],
        css=MC_CSS,
    )


def get_genanki_basic_model() -> genanki.Model:
    return genanki.Model(
        basic_model_id(),
        BASIC_MODEL_NAME,
        fields=[
            {"name": "Front"},
            {"name": "Back"},
        ],
        templates=[
            {
                "name": "Card 1",
                "qfmt": '{{Front}}',
                "afmt": '{{FrontSide<hr id="answer">{{Back}}',
            },
        ],
    )


def get_genanki_cloze_model() -> genanki.Model:
    return genanki.Model(
        cloze_model_id(),
        CLOZE_MODEL_NAME,
        model_type=genanki.Model.CLOZE,
        fields=[
            {"name": "Text"},
            {"name": "Back Extra"},
        ],
        templates=[
            {
                "name": "Cloze",
                "qfmt": "{{cloze:Text}}",
                "afmt": "{{cloze:Text}}<br>{{Back Extra}}",
            },
        ],
    )


def deck_id_for_name(deck_name: str) -> int:
    return deterministic_id(f"lecture-rip:deck:{deck_name}")


def ensure_collection_mc_model(col: Any) -> int:
    """Ensure JKU MC notetype exists in a native Anki Collection; return model id."""
    models = col.models
    existing = models.by_name(MODEL_MC_NAME)
    if existing:
        return existing["id"]

    model = models.new(MODEL_MC_NAME)
    model["css"] = MC_CSS
    for fname in ("Question", "Options JSON", "Correct", "Explanation"):
        field = models.new_field(fname)
        models.add_field(model, field)

    template = models.new_template("MC")
    template["qfmt"] = MC_FRONT
    template["afmt"] = MC_BACK
    models.add_template(model, template)
    models.add(model)
    return model["id"]


def collection_model_id(col: Any, card_type: str) -> int:
    if card_type == "mc":
        return ensure_collection_mc_model(col)
    if card_type == "basic":
        mid = col.models.by_name(BASIC_MODEL_NAME)
        if not mid:
            raise RuntimeError("Basic model missing from collection")
        return mid["id"]
    if card_type == "cloze":
        mid = col.models.by_name(CLOZE_MODEL_NAME)
        if not mid:
            raise RuntimeError("Cloze model missing from collection")
        return mid["id"]
    raise ValueError(f"Unknown card type: {card_type}")


def note_fields_for_card(card: dict[str, Any]) -> list[str]:
    ctype = card["type"]
    if ctype == "mc":
        return [
            card["front"],
            json.dumps(card.get("options") or [], ensure_ascii=False),
            str(int(card.get("correct", 0))),
            card["back"],
        ]
    if ctype == "basic":
        return [card["front"], card["back"]]
    if ctype == "cloze":
        return [card["front"], card["back"]]
    raise ValueError(f"Unknown card type: {ctype}")
