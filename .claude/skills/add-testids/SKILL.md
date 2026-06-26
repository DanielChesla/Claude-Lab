---
name: add-testids
description: Insert unique data-testid attributes on form inputs and interactive elements (input, select, textarea, button, a, and [role]) in an HTML file, using the pattern <field-shortname>-<fieldtype>-<increment>. Use when the user wants to add data-testid / testid attributes for test automation (Playwright, Cypress, Testing Library) to a page, or to audit a page for missing/duplicate testids.
---

# Add data-testid attributes

Adds unique, collision-free `data-testid` attributes to interactive elements so
they can be targeted reliably by automated tests.

## Pattern

```
<field-shortname>-<fieldtype>-<increment>
```

Examples: `email-address-email-1`, `remember-me-checkbox-1`, `sign-in-button-1`.

## How to run

Dependency-free Node script. Always preview with `--dry-run` first and show the
user the planned testids before applying, unless told to just apply.

```bash
# Preview (no files changed):
node .claude/skills/add-testids/add_testids.js path/to/page.html --dry-run

# Apply:
node .claude/skills/add-testids/add_testids.js path/to/page.html

# Multiple files:
node .claude/skills/add-testids/add_testids.js a.html b.html
```

After running, report the printed summary (each element, its testid, the action
taken, and which source the shortname came from) plus any ⚠ warnings.

## Flags

| Flag | Effect |
|------|--------|
| `--dry-run` | Show what would change; write nothing. |
| `--stable` | Preserve existing testid numbers; only assign fresh numbers to new elements. Use for **maintained suites** so inserting/reordering fields doesn't churn existing ids (and break tests). |
| `--check` | Audit only: report elements missing a testid and any duplicate values. Writes nothing; **exits non-zero** if issues found (good for CI). |
| `--json` | Emit machine-readable JSON instead of the text summary. |
| `--manifest <path>` | Write a JSON manifest (`testid → tag, source, selector`) — handy for then writing Playwright/Cypress tests. |

## Rules (locked spec)

| Part | Behavior |
|------|----------|
| **Targets** | `<input>`, `<select>`, `<textarea>`, `<button>`, `<a>`, and any element with a `role`. `<input type="hidden">` is skipped. |
| **shortname** | first non-empty of: `<label>` → `aria-labelledby` → `name` → `id` → `placeholder` → `aria-label` → `title` → visible text → nearest heading/`<legend>` → `"field"`, slugified to kebab-case |
| **fieldtype** | input's `type` (untyped input → `text`); `<a>` → `link`; `select`/`textarea`/`button` → tag name; other role-bearing tags → tag name |
| **increment** | per `shortname-fieldtype`. Default: regenerate, numbered from `1` in document order (idempotent). `--stable`: keep existing numbers, fill new ones. |

Label association covers `<label for="id">` and wrapping `<label><input>…</label>`.

## Escape hatches (per element)

- `data-testid-skip` — element is left **completely untouched** (no testid added,
  existing one preserved, not counted as "missing" by `--check`).
- `data-testid-lock` — element's existing `data-testid` **value is preserved**
  verbatim even in regenerate mode.

## Notes / limitations

- Only **opening tags are edited**; all other formatting is preserved.
- `<script>`, `<style>`, and HTML comment regions are skipped.
- Built for **HTML** (and HTML inside templates). It is not a full JSX/Vue parser
  (custom `<Components>` and dynamic `:attr`/`{expr}` aren't handled) — dry-run and
  review for those.
- Warnings flag weak results: a `field` fallback (no usable label) or a generic
  fieldtype from a role-bearing non-standard tag (e.g. `…-div-1`). If one looks
  wrong for the user's case, surface it.
