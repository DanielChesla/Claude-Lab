#!/usr/bin/env node
/*
 * add_testids.js — insert unique data-testid attributes on form inputs and
 * interactive elements.
 *
 * Pattern:  <field-shortname>-<fieldtype>-<increment>
 *
 * Targets: <input>, <select>, <textarea>, <button>, <a>, and any element with a
 * `role` attribute. <input type="hidden"> is ignored (not interactive UI).
 *
 * shortname priority chain (first non-empty wins, slugified to kebab-case):
 *   label -> aria-labelledby -> name -> id -> placeholder -> aria-label ->
 *   title -> visible text -> nearest heading/legend -> "field"
 *
 * fieldtype: input's `type` (untyped input -> "text"); <a> -> "link";
 *   select/textarea/button -> tag name; other role-bearing tags -> tag name.
 *
 * increment: per (shortname + fieldtype).
 *   - default: regenerate all, numbered from 1 in document order (idempotent).
 *   - --stable: keep existing testid numbers, only assign fresh numbers to new
 *     elements (survives inserts/reorders without churning existing ids).
 *
 * Escape hatches:
 *   - data-testid-skip : element is left completely untouched.
 *   - data-testid-lock : element's existing data-testid value is preserved.
 *
 * Usage:
 *   node add_testids.js <file ...> [--dry-run] [--stable]
 *                                  [--check] [--json] [--manifest <path>]
 *
 * No dependencies. Only opening tags are edited (formatting preserved);
 * <script>, <style>, and comments are skipped.
 */
"use strict";
const fs = require("fs");

const TARGET_TAGS = new Set(["input", "select", "textarea", "button", "a"]);
const VOID_TAGS = new Set(["input"]);

/* ---------- text helpers ---------- */
function slugify(s, maxLen = 40) {
  return String(s)
    .replace(/&[a-z]+;/gi, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/g, "");
}
function stripTags(s) {
  return s.replace(/<[^>]*>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function parseAttrs(blob) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(blob))) {
    const key = m[1].toLowerCase();
    const val = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5] !== undefined ? m[5] : "";
    attrs[key] = val;
  }
  return attrs;
}
function maskRegions(html) {
  const blank = (full) => full.replace(/[^\n]/g, " ");
  let out = html.replace(/<!--[\s\S]*?-->/g, blank);
  out = out.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi, (a, o, body, c) => o + blank(body) + c);
  out = out.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (a, o, body, c) => o + blank(body) + c);
  return out;
}
function visibleText(html, tag, afterIndex) {
  const close = html.toLowerCase().indexOf("</" + tag, afterIndex);
  if (close === -1) return "";
  return stripTags(html.slice(afterIndex, close));
}

/* ---------- context collectors ---------- */
function collectLabels(html) {
  const labels = [];
  const re = /<label\b([^>]*)>([\s\S]*?)<\/label>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = parseAttrs(m[1]);
    labels.push({ start: m.index, end: m.index + m[0].length, for: attrs.for || null, text: stripTags(m[2]) });
  }
  const byFor = {};
  for (const l of labels) if (l.for) byFor[l.for] = l.text;
  return { labels, byFor };
}
// id -> inner text, for resolving aria-labelledby.
function buildIdText(html, masked) {
  const map = {};
  const re = /<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let m;
  while ((m = re.exec(masked))) {
    const attrs = parseAttrs(m[2]);
    if (attrs.id && !(attrs.id in map)) {
      const tag = m[1].toLowerCase();
      const txt = VOID_TAGS.has(tag) ? "" : visibleText(html, tag, m.index + m[0].length);
      if (txt) map[attrs.id] = txt;
    }
  }
  return map;
}
// Headings + legends, for fallback shortnames.
function collectAnchors(html) {
  const out = [];
  const re = /<(h[1-6]|legend)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(html))) out.push({ pos: m.index, text: stripTags(m[2]) });
  return out;
}
function nearestAnchor(anchors, pos) {
  let best = null;
  for (const a of anchors) if (a.pos < pos && a.text && (!best || a.pos > best.pos)) best = a;
  return best ? best.text : "";
}

function fieldType(tag, attrs) {
  if (tag === "input") { const t = (attrs.type || "").trim(); return t ? slugify(t) : "text"; }
  if (tag === "a") return "link";
  return tag; // select/textarea/button and role-bearing tags use their tag name
}

function computeShortname(el, ctx) {
  const a = el.attrs;
  let label = "";
  if (a.id && ctx.byFor[a.id]) label = ctx.byFor[a.id];
  if (!label) {
    let best = null;
    for (const l of ctx.labels)
      if (!l.for && el.start > l.start && el.start < l.end && (!best || l.end - l.start < best.end - best.start)) best = l;
    if (best) label = best.text;
  }
  let albl = "";
  if (a["aria-labelledby"])
    albl = a["aria-labelledby"].split(/\s+/).map((id) => ctx.idText[id] || "").filter(Boolean).join(" ");
  const vis = VOID_TAGS.has(el.tag) ? "" : visibleText(ctx.html, el.tag, el.end);

  const chain = [
    ["label", label], ["aria-labelledby", albl], ["name", a.name], ["id", a.id],
    ["placeholder", a.placeholder], ["aria-label", a["aria-label"]], ["title", a.title], ["text", vis]
  ];
  for (const [source, val] of chain) if (val && slugify(val)) return { source, shortname: slugify(val) };
  const anchor = nearestAnchor(ctx.anchors, el.start);
  if (anchor && slugify(anchor)) return { source: "nearby-heading", shortname: slugify(anchor) };
  return { source: "fallback", shortname: "field" };
}

/* ---------- core ---------- */
function collectElements(html, masked) {
  const els = [];
  const re = /<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let m;
  while ((m = re.exec(masked))) {
    const tag = m[1].toLowerCase();
    const attrs = parseAttrs(m[2]);
    const isTarget = TARGET_TAGS.has(tag) || "role" in attrs;
    if (!isTarget) continue;
    if (tag === "input" && (attrs.type || "").toLowerCase() === "hidden") continue; // #1 skip hidden
    const start = m.index, end = start + m[0].length;
    els.push({ tag, attrs, start, end, rawTag: html.slice(start, end), viaRole: !TARGET_TAGS.has(tag) });
  }
  return els;
}

function setTestid(rawTag, value) {
  const cleaned = rawTag.replace(/\s+data-testid\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+)/gi, "");
  const selfClose = cleaned.endsWith("/>");
  const close = selfClose ? "/>" : ">";
  const body = cleaned.slice(0, cleaned.length - close.length); // attrs (may end in whitespace/newline)
  const trail = (body.match(/\s*$/) || [""])[0];                // preserve trailing whitespace before close
  const core = body.slice(0, body.length - trail.length);
  // Insert after the last attribute, keeping any original whitespace before the
  // close bracket so multi-line tags aren't collapsed.
  return core + ` data-testid="${value}"` + trail + close;
}

function transform(html, opts) {
  const masked = maskRegions(html);
  const { labels, byFor } = collectLabels(html);
  const ctx = { html, labels, byFor, idText: buildIdText(html, masked), anchors: collectAnchors(html) };
  const els = collectElements(html, masked);

  // ---- check mode: report missing / duplicate, no edits ----
  if (opts.check) {
    const seen = {}; const missing = []; const dups = [];
    for (const el of els) {
      if ("data-testid-skip" in el.attrs) continue;
      const v = el.attrs["data-testid"];
      if (!v) { missing.push(el); continue; }
      (seen[v] = seen[v] || []).push(el);
    }
    for (const v in seen) if (seen[v].length > 1) dups.push({ value: v, count: seen[v].length });
    return { check: { missing, dups, total: els.length } };
  }

  // ---- classify ----
  const reserved = {}; // key -> Set(numbers) already taken (from locked/kept)
  const ensure = (k) => (reserved[k] = reserved[k] || new Set());
  const managed = [];
  const results = [];
  const warnings = [];
  // Optional namespace prefix — use for shared fragments (nav, footer) that get
  // merged into one DOM, so their testids don't collide across files.
  const prefix = opts.prefix ? slugify(opts.prefix) + "-" : "";

  for (const el of els) {
    const existing = el.attrs["data-testid"];
    if ("data-testid-skip" in el.attrs) { results.push({ ...meta(el), testid: existing || null, action: "skipped" }); continue; }
    const { source, shortname } = computeShortname(el, ctx);
    const ftype = fieldType(el.tag, el.attrs);
    el.key = `${prefix}${shortname}-${ftype}`; el.source = source; el.shortname = shortname; el.ftype = ftype;

    if ("data-testid-lock" in el.attrs && existing) {
      // reserve its number if it matches the key pattern, so we don't collide
      const mm = existing.match(new RegExp(`^${escapeRe(el.key)}-(\\d+)$`));
      if (mm) ensure(el.key).add(Number(mm[1]));
      results.push({ ...meta(el), testid: existing, action: "locked" });
      continue;
    }
    el.existing = existing; managed.push(el);
  }

  // pre-seed reserved from locked values handled above; assign numbers
  if (opts.stable) {
    // pass 1: keep valid existing numbers
    for (const el of managed) {
      const mm = el.existing && el.existing.match(new RegExp(`^${escapeRe(el.key)}-(\\d+)$`));
      if (mm && !ensure(el.key).has(Number(mm[1]))) { ensure(el.key).add(Number(mm[1])); el.testid = el.existing; el.kept = true; }
    }
    // pass 2: assign smallest free number to the rest
    for (const el of managed) {
      if (el.testid) continue;
      const set = ensure(el.key); let n = 1; while (set.has(n)) n++; set.add(n);
      el.testid = `${el.key}-${n}`;
    }
  } else {
    // regenerate: sequential per key from 1, skipping any locked-reserved numbers
    const counter = {};
    for (const el of managed) {
      const set = ensure(el.key); let n = counter[el.key] || 0;
      do { n++; } while (set.has(n));
      counter[el.key] = n; set.add(n);
      el.testid = `${el.key}-${n}`;
    }
  }

  // ---- build edits + results + warnings ----
  const edits = [];
  for (const el of managed) {
    if (!(el.action === "skipped")) {
      if (el.existing !== el.testid) edits.push({ start: el.start, end: el.end, newTag: setTestid(el.rawTag, el.testid) });
    }
    results.push({ ...meta(el), testid: el.testid, action: el.kept ? "kept" : "generated", source: el.source });
    if (el.source === "fallback") warnings.push(`${el.testid}: no label/name/text found — used fallback "field"`);
    if (el.viaRole) warnings.push(`${el.testid}: matched via role; fieldtype is the raw tag "${el.tag}"`);
  }

  edits.sort((a, b) => b.start - a.start);
  let out = html;
  for (const e of edits) out = out.slice(0, e.start) + e.newTag + out.slice(e.end);
  return { out, results, warnings };
}

function meta(el) {
  return { tag: el.tag, source: el.source || null, selector: el.testid ? `[data-testid="${el.testid}"]` : null };
}

/* ---------- CLI ---------- */
function main() {
  const argv = process.argv.slice(2);
  const opts = { dryRun: argv.includes("--dry-run"), stable: argv.includes("--stable"),
                 check: argv.includes("--check"), json: argv.includes("--json"), manifest: null, prefix: null };
  const mi = argv.indexOf("--manifest");
  if (mi !== -1) opts.manifest = argv[mi + 1];
  const pi = argv.indexOf("--prefix");
  if (pi !== -1) opts.prefix = argv[pi + 1];
  const skip = new Set([opts.manifest, opts.prefix]);
  const files = argv.filter((a) => !a.startsWith("--") && !skip.has(a));
  if (!files.length) {
    console.error("Usage: node add_testids.js <file ...> [--dry-run] [--stable] [--check] [--json] [--manifest <path>]");
    process.exit(1);
  }

  const allResults = [];
  let issues = 0, total = 0;

  for (const file of files) {
    let html;
    try { html = fs.readFileSync(file, "utf8"); }
    catch (e) { console.error(`! cannot read ${file}: ${e.message}`); issues++; continue; }
    const r = transform(html, opts);

    if (opts.check) {
      const { missing, dups } = r.check;
      if (!opts.json) {
        console.log(`\n${file} — ${r.check.total} target element(s)`);
        console.log(`  missing data-testid: ${missing.length}`);
        missing.forEach((el) => console.log(`    <${el.tag}> at offset ${el.start}`));
        console.log(`  duplicate values: ${dups.length}`);
        dups.forEach((d) => console.log(`    "${d.value}" × ${d.count}`));
      } else {
        allResults.push({ file, missing: missing.length, duplicates: dups });
      }
      issues += missing.length + dups.length;
      continue;
    }

    if (!opts.dryRun && r.out !== html) fs.writeFileSync(file, r.out, "utf8");
    total += r.results.filter((x) => x.action === "generated" || x.action === "kept").length;
    r.results.forEach((x) => allResults.push({ file, ...x }));

    if (!opts.json) {
      console.log(`\n${file} — ${r.results.length} element(s)${opts.dryRun ? " [dry-run]" : ""}${opts.stable ? " [stable]" : ""}`);
      for (const x of r.results)
        console.log(`  ${(x.testid || "(skipped)").padEnd(42)} ${x.action.padEnd(10)} ${x.tag}${x.source ? " · from " + x.source : ""}`);
      if (r.warnings.length) { console.log("  warnings:"); r.warnings.forEach((w) => console.log(`    ⚠ ${w}`)); }
    }
  }

  if (opts.manifest) {
    fs.writeFileSync(opts.manifest, JSON.stringify(allResults, null, 2), "utf8");
    if (!opts.json) console.log(`\nManifest written to ${opts.manifest}`);
  }
  if (opts.json) console.log(JSON.stringify(allResults, null, 2));

  if (opts.check) {
    if (!opts.json) console.log(`\n${issues ? "✗ " + issues + " issue(s) found." : "✓ No issues."}`);
    process.exit(issues ? 1 : 0);
  } else if (!opts.json) {
    console.log(`\nDone. ${total} data-testid attribute(s) ${opts.dryRun ? "would be " : ""}written.`);
  }
}
main();
