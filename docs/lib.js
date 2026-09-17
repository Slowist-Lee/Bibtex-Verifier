/*
 * BibLib — pure logic functions for BibTeX Verifier.
 * Works as a browser global (window.BibLib) and as a Node.js module.
 */
(function (exports) {
  "use strict";

  // ─── Configuration ───────────────────────────────────────────────────
  const TITLE_MATCH_THRESHOLD = 85;
  const MIN_TITLE_SIM = 70;
  const COMPARED_FIELDS = [
    "author", "year", "journal", "booktitle",
    "volume", "number", "pages", "doi", "publisher",
  ];

  // ─── LaTeX helpers ───────────────────────────────────────────────────
  const LATEX_ACCENT_MAP = {
    "\\'a":"á", "\\'e":"é", "\\'i":"í", "\\'o":"ó", "\\'u":"ú",
    "\\`a":"à", "\\`e":"è", "\\`i":"ì", "\\`o":"ò", "\\`u":"ù",
    '\\"a':"ä", '\\"e':"ë", '\\"i':"ï", '\\"o':"ö", '\\"u':"ü",
    "\\~n":"ñ", "\\~a":"ã", "\\~o":"õ",
    "\\^a":"â", "\\^e":"ê", "\\^i":"î", "\\^o":"ô", "\\^u":"û",
    "\\c{c}":"ç", "\\c c":"ç", "{\\ss}":"ß",
  };

  function stripLatex(text) {
    if (!text) return "";
    for (const [latex, ch] of Object.entries(LATEX_ACCENT_MAP))
      text = text.replaceAll(latex, ch);
    text = text.replace(/\\[a-zA-Z]+\s*/g, "");
    text = text.replace(/[{}]/g, "");
    return text.replace(/\s+/g, " ").trim();
  }

  function normalizeTitle(title) {
    return stripLatex(title).toLowerCase().trim();
  }

  // ─── BibTeX parser / serializer ──────────────────────────────────────
  function skipWhitespace(str, i) {
    while (i < str.length && /\s/.test(str[i])) i++;
    return i;
  }

  /** Append missing `}` so nested `{...}` recover from typos like `{{Foo},` before next field. */
  function balanceClosingBraces(s) {
    let net = 0;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "{") net++;
      else if (s[i] === "}") net--;
    }
    let out = s;
    while (net > 0) {
      out += "}";
      net--;
    }
    return out;
  }

  /**
   * Parse `{...}` with nested-brace awareness. If the user omits the closing `}` before `,`
   * and the next token looks like another field (`title =`), treat the comma as the field
   * separator and repair inner braces (common with `{{GitHub},` typos).
   */
  function extractBracedFieldValue(str, start) {
    if (str[start] !== "{") return { value: "", next: start };
    let i = start + 1;
    let depth = 1;
    while (i < str.length && depth > 0) {
      const c = str[i];
      if (c === "{") {
        depth++;
        i++;
      } else if (c === "}") {
        depth--;
        i++;
        if (depth === 0) {
          const inner = str.slice(start + 1, i - 1);
          let next = skipWhitespace(str, i);
          if (str[next] === ",") next = skipWhitespace(str, next + 1);
          return { value: inner, next };
        }
      } else if (depth === 1 && c === ",") {
        const tail = str.slice(i + 1);
        if (/^\s*(?:\r?\n\s*)?\w+\s*=/.test(tail)) {
          const inner = str.slice(start + 1, i);
          return {
            value: balanceClosingBraces(inner),
            next: skipWhitespace(str, i + 1),
          };
        }
        i++;
      } else {
        i++;
      }
    }
    const inner = str.slice(start + 1);
    return { value: balanceClosingBraces(inner), next: str.length };
  }

  function extractQuotedFieldValue(str, start) {
    if (str[start] !== '"') return { value: "", next: start };
    let i = start + 1;
    let buf = "";
    while (i < str.length) {
      const c = str[i];
      if (c === "\\" && i + 1 < str.length) {
        buf += str[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') {
        i++;
        let next = skipWhitespace(str, i);
        if (str[next] === ",") next = skipWhitespace(str, next + 1);
        return { value: buf, next };
      }
      buf += c;
      i++;
    }
    return { value: buf, next: str.length };
  }

  function extractNumberFieldValue(str, start) {
    const m = /^(\d+)/.exec(str.slice(start));
    if (!m) return { value: "", next: start };
    let next = start + m[1].length;
    next = skipWhitespace(str, next);
    if (str[next] === ",") next = skipWhitespace(str, next + 1);
    return { value: m[1], next };
  }

  function parseEntryFields(body) {
    const fields = {};
    let i = skipWhitespace(body, 0);
    while (i < body.length) {
      const nameMatch = /^(\w+)\s*=\s*/.exec(body.slice(i));
      if (!nameMatch) break;
      const key = nameMatch[1].toLowerCase();
      i += nameMatch[0].length;
      i = skipWhitespace(body, i);
      if (i >= body.length) break;

      let ext;
      if (body[i] === "{") ext = extractBracedFieldValue(body, i);
      else if (body[i] === '"') ext = extractQuotedFieldValue(body, i);
      else if (/\d/.test(body[i])) ext = extractNumberFieldValue(body, i);
      else break;

      fields[key] = ext.value.replace(/\s*\n\s*/g, " ").trim();
      i = ext.next;
      i = skipWhitespace(body, i);
    }
    return fields;
  }

  function parseBib(content) {
    const entries = [];
    // An entry header is `@type{key,`. An entry body runs from just after that
    // header to the start of the next header (or end of input). We must NOT end
    // the body at the first `@` — field values legitimately contain `@`
    // (emails in `note`, URLs, etc.), and stopping there silently drops every
    // field after it. Collect all header positions first, then slice bodies
    // between them.
    const headerRe = /@(\w+)\s*\{([^,]*),/g;
    const headers = [];
    let m;
    while ((m = headerRe.exec(content)) !== null) {
      headers.push({
        type: m[1].toLowerCase(),
        id: m[2].trim(),
        headerStart: m.index,
        bodyStart: headerRe.lastIndex,
      });
    }
    for (let h = 0; h < headers.length; h++) {
      const hdr = headers[h];
      if (hdr.type === "string" || hdr.type === "preamble" || hdr.type === "comment")
        continue;
      const bodyEnd = h + 1 < headers.length ? headers[h + 1].headerStart : content.length;
      let body = content.slice(hdr.bodyStart, bodyEnd);
      body = body.replace(/\}\s*$/, "").trim();
      const entry = { ENTRYTYPE: hdr.type, ID: hdr.id };
      Object.assign(entry, parseEntryFields(body));
      entries.push(entry);
    }
    return entries;
  }

  function entriesToBib(entries) {
    const lines = [];
    for (const entry of entries) {
      const type = entry.ENTRYTYPE || "misc";
      const id = entry.ID || "unknown";
      lines.push(`@${type}{${id},`);
      for (const [k, v] of Object.entries(entry)) {
        if (k === "ENTRYTYPE" || k === "ID" || k.startsWith("_")) continue;
        lines.push(`  ${k} = {${v}},`);
      }
      lines.push("}\n");
    }
    return lines.join("\n");
  }

  // ─── Fuzzy matching ──────────────────────────────────────────────────
  // --- Bib style normalization ---------------------------------------
  const CONFERENCE_ENTRY_TYPES = new Set(["inproceedings", "conference", "proceedings"]);
  const JOURNAL_ENTRY_TYPES = new Set(["article", "periodical"]);

  /**
   * Split a BibTeX author string into author parts, dropping explicit
   * truncation markers such as "and others" and "et al.".
   */
  function authorParts(authorStr) {
    if (!authorStr) return [];
    return String(authorStr)
      .split(/\s+and\s+/i)
      .map(part => part.trim())
      .filter(part => part && !/^(?:others|et\.?\s+al\.?)$/i.test(part));
  }

  /**
   * Replace an explicitly truncated author list with a complete list from a
   * verified record when the record is clearly the same author list plus the
   * omitted authors. This never invents authors.
   */
  function isTruncatedAuthor(authorStr) {
    return /\s+and\s+others\b|\bet\.?\s+al\.?/i.test(String(authorStr || ""));
  }

  /**
   * A given name has real detail only when it contains something longer than
   * an initial (for example, "Ashish"). Initials such as "N. D." are not an
   * error, but they are also not a complete author name for the user's style.
   */
  function hasGivenDetail(name) {
    let given = "";
    const text = String(name || "").trim();
    if (text.includes(",")) given = text.split(",")[1] || "";
    else {
      const parts = text.split(/\s+/).filter(Boolean);
      if (parts.length > 1) given = parts.slice(0, -1).join(" ");
    }
    given = stripLatex(given).replace(/[^A-Za-z.\-\s']/g, " ").trim();
    if (!given) return false;
    return given.split(/\s+/).some(token => {
      const letters = token.replace(/[^A-Za-z]/g, "");
      return letters.length > 1;
    });
  }

  /**
   * True when every substantive name in the list uses initials only. We never
   * treat this as a verification error, but we also never use it to replace a
   * fuller author list.
   */
  function isAbbreviatedAuthors(authorStr) {
    const parts = authorParts(authorStr);
    return parts.length > 0 && parts.every(part => !hasGivenDetail(part));
  }

  function authorDetailScore(authorStr) {
    const parts = authorParts(authorStr);
    if (!parts.length) return -1;
    let score = 0;
    for (const part of parts) {
      const text = String(part).trim();
      const comma = text.includes(",");
      const given = comma ? (text.split(",")[1] || "")
        : (text.split(/\s+/).slice(0, -1).join(" "));
      const tokens = stripLatex(given).split(/\s+/).filter(Boolean);
      for (const token of tokens) {
        const letters = token.replace(/[^A-Za-z]/g, "");
        if (letters.length > 1) score += 3;
        else if (letters.length === 1) score += 1;
      }
    }
    score += Math.min(parts.length, 10) * 0.1;
    if (isTruncatedAuthor(authorStr)) score -= 5;
    return score;
  }

  /**
   * Prefer a verified full author list over initials. Initials are accepted as
   * equivalent for comparison, but never replace a name such as "Noam Shazeer".
   */
  function preferredAuthor(a, b) {
    a = a || ""; b = b || "";
    if (!a) return b;
    if (!b) return a;
    const as = extractLastNames(a), bs = extractLastNames(b);
    if (!as.size || !bs.size) return a;

    const larger = as.size >= bs.size ? as : bs;
    const smaller = as.size >= bs.size ? bs : as;
    let inter = 0;
    for (const name of smaller) if (larger.has(name)) inter++;

    // Same list up to initials: choose the fuller, non-truncated version.
    if (inter === Math.max(as.size, bs.size)) {
      const ta = isTruncatedAuthor(a), tb = isTruncatedAuthor(b);
      if (ta !== tb) return ta ? b : a;
      const da = authorDetailScore(a), db = authorDetailScore(b);
      if (Math.abs(da - db) >= 0.5) return da > db ? a : b;
      return a;
    }

    // One list is a strict superset of the other: use the longer verified list.
    if (inter === smaller.size && larger.size > smaller.size) {
      const ta = isTruncatedAuthor(a), tb = isTruncatedAuthor(b);
      const longer = as.size >= bs.size ? a : b;
      const shorter = as.size >= bs.size ? b : a;
      if (ta !== tb) return ta ? shorter : longer;
      return longer;
    }

    return a;
  }

  function completeAuthors(entry, found) {
    const out = { ...entry };
    const foundAuthor = found && found.author ? found.author : "";
    const parts = authorParts(out.author);

    if (!parts.length) {
      if (foundAuthor && !isTruncatedAuthor(foundAuthor) && !isAbbreviatedAuthors(foundAuthor))
        out.author = foundAuthor;
      return out;
    }

    const rawParts = String(out.author).split(/\s+and\s+/i).filter(part => part.trim());
    const truncated = parts.length !== rawParts.length;
    if (!truncated || !foundAuthor) return out;

    const foundParts = authorParts(foundAuthor);
    const origLastNames = new Set(extractLastNames(parts.join(" and ")));
    const foundLastNames = new Set(extractLastNames(foundAuthor));
    const complete =
      foundParts.length >= parts.length &&
      !isTruncatedAuthor(foundAuthor) &&
      !isAbbreviatedAuthors(foundAuthor) &&
      [...origLastNames].every(name => foundLastNames.has(name));
    if (complete) out.author = foundAuthor;
    return out;
  }

  function recordIsConference(record) {
    if (!record) return false;
    const type = (record._type || "").toLowerCase();
    if (type.includes("proceedings") || type.includes("conference")) return true;
    if (type.includes("journal") || type.includes("article")) return false;
    const venue = (record.journal || record.booktitle || "").toLowerCase();
    if (/\b(?:proceedings|conference|symposium|workshop|annual meeting)\b/.test(venue)) return true;
    return false;
  }

  function recordIsJournal(record) {
    if (!record) return false;
    const type = (record._type || "").toLowerCase();
    if (type.includes("journal-article") || type === "article" || type.includes("journal")) return true;
    if (type.includes("proceedings") || type.includes("conference")) return false;
    const venue = (record.journal || record.booktitle || "").toLowerCase();
    if (/\b(?:journal|transactions|surveys|letters|review)\b/.test(venue)) return true;
    return false;
  }

  function extractArxivId(record) {
    if (!record) return "";
    if (record._arxiv_id) return String(record._arxiv_id);
    const doi = (record.doi || "").toLowerCase();
    const doiMatch = /(?:^|\/)arxiv\.(\d{4}\.\d{4,5})(?:v\d+)?$/.exec(doi);
    if (doiMatch) return doiMatch[1];
    const url = (record.url || "").toLowerCase();
    const urlMatch = /arxiv\.org\/abs\/(\d{4}\.\d{4,5})(?:v\d+)?$/.exec(url);
    if (urlMatch) return urlMatch[1];
    return "";
  }

  function preferredArxivJournal(entry, found) {
    const exactRe = /arxiv\s+preprint\s+arxiv:/i;
    const foundJournal = found?.journal || "";
    const id = extractArxivId(found) || extractArxivId(entry);

    if (exactRe.test(foundJournal)) return foundJournal;
    if (id) return `arXiv preprint arXiv:${id}`;

    const fromEntry = entry?.journal || entry?.howpublished || "";
    if (exactRe.test(fromEntry)) return fromEntry;

    const venue = foundJournal || found?.booktitle || "";
    if (/\barxiv\b/i.test(venue)) return venue;
    if (/\barxiv\b/i.test(fromEntry)) return fromEntry;
    return venue;
  }

  /**
   * Upgrade a `@misc` entry when a verified record supplies a real venue.
   * arXiv records are treated as `@article` entries with
   * `journal = {arXiv preprint arXiv:<id>}`, matching the user's style.
   */
  function inferEntryType(entry, found) {
    if (!entry || (entry.ENTRYTYPE || "misc").toLowerCase() !== "misc") return "misc";
    if (!found) return "misc";
    if (isPreprint(found)) return "article";
    if (recordIsConference(found)) return "inproceedings";
    if (recordIsJournal(found)) return "article";
    return "misc";
  }

  function upgradeMiscEntry(entry, found) {
    const out = { ...entry };
    if (!found || (out.ENTRYTYPE || "misc").toLowerCase() !== "misc") return out;
    const type = inferEntryType(out, found);
    if (type === "misc") return out;

    if (type === "article" && isPreprint(found)) {
      const journal = preferredArxivJournal(out, found);
      if (!journal) return out;
      out.ENTRYTYPE = "article";
      out.journal = journal;
      delete out.howpublished;
      delete out.booktitle;
      return out;
    }

    const venue = found.journal || found.booktitle || "";
    if (!venue && !(out.booktitle || out.journal)) return out;
    out.ENTRYTYPE = type;
    if (type === "inproceedings") {
      if (!out.booktitle && venue) out.booktitle = abbreviateVenue(venue);
      delete out.journal;
    } else if (type === "article") {
      if (venue) out.journal = abbreviateVenue(venue);
      delete out.booktitle;
    }
    return out;
  }
  /**
   * Apply the requested bibliography style:
   * - use abbreviations for common venues, but leave rare venues unchanged;
   * - conferences keep author, title, booktitle, and year;
   * - journals keep author, title, journal, year, volume, number, and pages;
   * - remove every other field.
   */
  function applyBibStyle(entry) {
    const out = { ...entry };
    const type = (out.ENTRYTYPE || "misc").toLowerCase();
    const isConference = CONFERENCE_ENTRY_TYPES.has(type);
    const isJournal = JOURNAL_ENTRY_TYPES.has(type);

    if (isConference) {
      if (!out.booktitle && out.journal) out.booktitle = out.journal;
      delete out.journal;
      delete out.pages;
    } else if (isJournal) {
      if (!out.journal && out.booktitle) out.journal = out.booktitle;
      delete out.booktitle;
    }

    if (out.booktitle) out.booktitle = abbreviateVenue(out.booktitle);
    if (out.journal) out.journal = abbreviateVenue(out.journal);

    const allowed = isConference
      ? new Set(["author", "title", "booktitle", "year"])
      : isJournal
        ? new Set(["author", "title", "journal", "year", "volume", "number", "pages"])
        : new Set(["author", "title", "year", "howpublished"]);
    for (const key of Object.keys(out)) {
      if (key === "ENTRYTYPE" || key === "ID" || key.startsWith("_")) continue;
      if (!allowed.has(key)) delete out[key];
    }

    return out;
  }

  function tokenSortRatio(a, b) {
    if (typeof fuzzball !== "undefined") return fuzzball.token_sort_ratio(a, b);
    a = a.toLowerCase(); b = b.toLowerCase();
    if (a === b) return 100;
    const longer = a.length > b.length ? a : b;
    const shorter = a.length > b.length ? b : a;
    if (longer.length === 0) return 100;
    let matches = 0;
    for (let i = 0; i < shorter.length; i++)
      if (longer.includes(shorter[i])) matches++;
    return Math.round((matches / longer.length) * 100);
  }

  function titleSimilarity(a, b) {
    return tokenSortRatio(a.toLowerCase().trim(), b.toLowerCase().trim());
  }

  function baseTitle(title) {
    const text = stripLatex(title || "").trim();
    const colon = text.indexOf(":");
    return colon > 0 ? text.slice(0, colon).trim() : text;
  }

  function lookupTitleVariants(title) {
    const full = stripLatex(title || "").trim();
    const base = baseTitle(full);
    const variants = [full];
    if (base && base.length >= 8 && normalizeTitle(base) !== normalizeTitle(full))
      variants.push(base);
    return [...new Set(variants)];
  }

  /**
   * Similarity for lookup/matching. A full title and the same title's base
   * (before the colon) refer to the same work; this prevents "Base: Long
   * Subtitle" from losing to a weakly similar paper when one database indexes
   * only the base title.
   */
  function lookupTitleSimilarity(a, b) {
    const na = normalizeTitle(a), nb = normalizeTitle(b);
    if (!na && !nb) return 100;
    if (!na || !nb) return 0;
    if (na === nb) return 100;
    const baseA = normalizeTitle(baseTitle(a));
    const baseB = normalizeTitle(baseTitle(b));
    if (baseA.length >= 10 && baseA === nb) return 100;
    if (baseB.length >= 10 && baseB === na) return 100;
    return tokenSortRatio(na, nb);
  }

  function titleMatchRank(a, b) {
    const na = normalizeTitle(a), nb = normalizeTitle(b);
    if (!na || !nb) return 0;
    if (na === nb) return 2;
    const baseA = normalizeTitle(baseTitle(a));
    const baseB = normalizeTitle(baseTitle(b));
    if ((baseA.length >= 10 && baseA === nb) ||
        (baseB.length >= 10 && baseB === na)) return 1;
    return 0;
  }

  // ─── Normalization helpers ───────────────────────────────────────────
  function normalizeText(text) {
    if (!text) return "";
    return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().trim().replace(/\s+/g, " ");
  }

  function normalizeAuthorSet(authorStr) {
    if (!authorStr) return new Set();
    const norm = normalizeText(authorStr);
    const parts = norm.split(/\s+and\s+/);
    const names = new Set();
    for (let a of parts) {
      a = a.trim();
      if (!a) continue;
      if (a.includes(",")) names.add(a.split(",")[0].trim());
      else { const t = a.split(/\s+/); names.add(t[t.length - 1]); }
    }
    return names;
  }

  function normalizePages(p) { return p.trim().replace(/\s*-+\s*/g, "-"); }

  // ─── Field comparison ────────────────────────────────────────────────
  function compareAuthors(a, b) {
    const sa = normalizeAuthorSet(a), sb = normalizeAuthorSet(b);
    if (!sa.size && !sb.size) return 100;
    if (!sa.size || !sb.size) return 0;
    let inter = 0;
    for (const n of sa) if (sb.has(n)) inter++;
    return (inter / Math.max(sa.size, sb.size)) * 100;
  }

  function compareField(field, a, b) {
    const na = normalizeText(a), nb = normalizeText(b);
    if (!na && !nb) return 100;
    if (!na || !nb) return 0;
    if (field === "year" || field === "doi") return na === nb ? 100 : 0;
    if (field === "author") return compareAuthors(a, b);
    if (field === "pages") return normalizePages(na) === normalizePages(nb) ? 100 : tokenSortRatio(na, nb);
    return tokenSortRatio(na, nb);
  }

  function compareEntry(original, found) {
    const origTitle = original.title || "";
    const foundTitle = found.title || "";
    const titleScore = lookupTitleSimilarity(origTitle, foundTitle);

    if (titleScore < TITLE_MATCH_THRESHOLD) {
      return { status: "needs_review", title_score: titleScore, field_diffs: [], suggested: found };
    }

    const foundJournal = found.journal || "";
    if (original.booktitle && !original.journal && foundJournal)
      found.booktitle = foundJournal;

    const foundIsPreprint = isPreprint(found);
    const fieldDiffs = [], enrichments = [];
    let hasDifference = false;

    for (const field of COMPARED_FIELDS) {
      const origVal = original[field] || "";
      const foundVal = found[field] || "";
      if (!origVal && !foundVal) continue;

      if (!origVal.trim() && foundVal.trim()) {
        enrichments.push({ field, original: origVal, found: foundVal, score: 0 });
        continue;
      }
      if (origVal.trim() && !foundVal.trim()) continue;

      // The found record is a preprint (e.g. arXiv), whose `year` is the
      // submission year. If the user's year is the same or newer, it's the
      // peer-reviewed publication year — keep it instead of suggesting the
      // older preprint year.
      if (field === "year" && foundIsPreprint && isNewerOrSamePublicationYear(origVal, foundVal)) {
        continue;
      }

      const score = compareField(field, origVal, foundVal);
      if (score < 100) {
        hasDifference = true;
        fieldDiffs.push({ field, original: origVal, found: foundVal, score: Math.round(score * 10) / 10 });
      }
    }

    const allDiffs = fieldDiffs.concat(enrichments);
    // Any actionable suggestion (mismatch or enrichment) means the entry is
    // auto-updated, not verified — "verified" is reserved for entries with
    // nothing for the user to review.
    const status = (hasDifference || enrichments.length) ? "updated" : "verified";
    const suggested = {};
    if (hasDifference || enrichments.length)
      for (const d of allDiffs) if (d.found) suggested[d.field] = d.found;

    return { status, title_score: Math.round(titleScore * 10) / 10, field_diffs: allDiffs, suggested };
  }

  /**
   * When compareEntry returns needs_review (title below threshold), field_diffs is empty.
   * Build a full diff against the closest `found` record so the UI can show suggestions
   * and per-field accept / revert actions.
   */
  function fieldDiffsForNeedsReview(original, found) {
    if (!found) return [];
    const merged = { ...found };
    const foundJournal = merged.journal || "";
    if (original.booktitle && !original.journal && foundJournal)
      merged.booktitle = foundJournal;

    const origTitle = original.title || "";
    const foundTitle = merged.title || "";
    const titleScore = lookupTitleSimilarity(origTitle, foundTitle);
    const fieldDiffs = [];
    const enrichments = [];

    if (origTitle.trim() || foundTitle.trim()) {
      fieldDiffs.push({
        field: "title",
        original: origTitle,
        found: foundTitle,
        score: Math.round(titleScore * 10) / 10,
      });
    }

    for (const field of COMPARED_FIELDS) {
      const origVal = original[field] || "";
      const foundVal = merged[field] || "";
      if (!origVal && !foundVal) continue;

      if (!origVal.trim() && foundVal.trim()) {
        enrichments.push({ field, original: origVal, found: foundVal, score: 0 });
        continue;
      }
      if (origVal.trim() && !foundVal.trim()) continue;

      const score = compareField(field, origVal, foundVal);
      if (score < 100) {
        fieldDiffs.push({
          field,
          original: origVal,
          found: foundVal,
          score: Math.round(score * 10) / 10,
        });
      }
    }

    return fieldDiffs.concat(enrichments);
  }

  // ─── API response converters ─────────────────────────────────────────
  function crossrefToStandard(item) {
    const authors = (item.author || []).map(a => {
      const f = a.family || "", g = a.given || "";
      return f ? `${f}, ${g}`.replace(/, $/, "") : "";
    }).filter(Boolean);

    const dp = item["published-print"] || item["published-online"] || {};
    const year = dp["date-parts"]?.[0]?.[0]?.toString() || "";
    const container = item["container-title"] || [];

    return {
      title: (item.title || [""])[0],
      author: authors.join(" and "),
      year,
      journal: container[0] || "",
      volume: item.volume || "",
      number: item.issue || "",
      pages: item.page || "",
      doi: item.DOI || "",
      publisher: item.publisher || "",
      url: item.URL || "",
      _source: "crossref",
      _type: item.type || "",
    };
  }

  function ssToStandard(paper) {
    const authors = (paper.authors || []).map(a => {
      const name = a.name || "";
      const parts = name.split(/\s+/);
      if (parts.length >= 2) return `${parts[parts.length - 1]}, ${parts.slice(0, -1).join(" ")}`;
      return name;
    }).filter(Boolean);

    const ext = paper.externalIds || {};
    const pv = paper.publicationVenue;
    let venue = (pv && typeof pv === "object" ? pv.name : null) || paper.venue || "";
    // Surface arXiv-only records so downstream logic can treat them as
    // preprints — their `year` is the submission year, not the published one.
    if (!venue && ext.ArXiv) venue = "arXiv";

    return {
      title: paper.title || "",
      author: authors.join(" and "),
      year: (paper.year || "").toString(),
      journal: venue,
      volume: "", number: "", pages: "",
      doi: ext.DOI || "",
      publisher: "",
      url: ext.DOI ? `https://doi.org/${ext.DOI}` : "",
      _source: "semantic_scholar",
      _arxiv_id: ext.ArXiv || "",
    };
  }

  function openAlexToStandard(work) {
    const authors = (work.authorships || []).map(a => {
      const name = (a.author && a.author.display_name) || "";
      const parts = name.split(/\s+/);
      if (parts.length >= 2) return `${parts[parts.length - 1]}, ${parts.slice(0, -1).join(" ")}`;
      return name;
    }).filter(Boolean);

    const source = (work.primary_location && work.primary_location.source) || {};
    const biblio = work.biblio || {};
    const first = biblio.first_page || "";
    const last = biblio.last_page || "";
    const pages = first && last ? `${first}-${last}` : (first || last || "");
    // OpenAlex reports DOIs as full URLs (https://doi.org/10.x); store the bare DOI.
    const doi = (work.doi || "").replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");

    return {
      title: work.title || work.display_name || "",
      author: authors.join(" and "),
      year: (work.publication_year || "").toString(),
      journal: source.display_name || "",
      volume: biblio.volume || "",
      number: biblio.issue || "",
      pages,
      doi,
      publisher: source.host_organization_name || "",
      url: doi ? `https://doi.org/${doi}` : (work.id || ""),
      _source: "openalex",
      _type: work.type || "",
    };
  }

  // ─── Paper matching helpers ──────────────────────────────────────────
  function extractLastNames(authorStr) {
    if (!authorStr) return new Set();
    const names = new Set();
    for (let part of authorStr.split(/\s+and\s+/i)) {
      part = part.trim();
      if (!part) continue;
      if (part.includes(",")) names.add(part.split(",")[0].trim().toLowerCase());
      else { const t = part.split(/\s+/); names.add(t[t.length - 1].toLowerCase()); }
    }
    return names;
  }

  // ─── Preprint awareness ──────────────────────────────────────────────
  // Fields where the peer-reviewed record should win when merged with a
  // preprint version of the same paper.
  const PUBLISHED_PREFERRED_FIELDS = ["year", "journal", "volume", "number", "pages", "publisher", "doi"];
  // Preprint and published versions of the same paper rarely differ by more
  // than a couple of years; allow this gap when cross-referencing sources.
  const PREPRINT_YEAR_TOLERANCE = 2;

  /**
   * True when a standard record looks like an arXiv (or similar) preprint.
   * Preprints report the submission year, which is usually earlier than the
   * peer-reviewed publication year.
   */
  function isPreprint(record) {
    if (!record) return false;
    const doi = (record.doi || "").toLowerCase();
    if (doi.startsWith("10.48550/arxiv")) return true;
    const venue = (record.journal || "").toLowerCase().trim();
    if (/\barxiv\b/.test(venue)) return true;
    if (venue === "corr" || venue.includes("computing research repository")) return true;
    const url = (record.url || "").toLowerCase();
    if (url.includes("arxiv.org")) return true;
    // An arXiv ID alone is a preprint; an arXiv ID alongside a real published
    // venue should stay a published record.
    if (!venue && record._arxiv_id) return true;
    return false;
  }

  /**
   * True when `origYear` is the same as, or a little newer than, `foundYear` —
   * i.e. the user's year plausibly reflects the published version of a paper
   * whose `found` record is an earlier preprint.
   */
  function isNewerOrSamePublicationYear(origYear, foundYear) {
    const oy = parseInt(origYear, 10), fy = parseInt(foundYear, 10);
    if (!Number.isFinite(oy) || !Number.isFinite(fy)) return false;
    return oy >= fy && oy - fy <= PREPRINT_YEAR_TOLERANCE + 1;
  }

  function isSamePaper(a, b) {
    if (lookupTitleSimilarity(a.title || "", b.title || "") < 85) return false;
    if (a.year && b.year) {
      const ya = parseInt(a.year, 10), yb = parseInt(b.year, 10);
      if (Number.isFinite(ya) && Number.isFinite(yb) &&
          Math.abs(ya - yb) > PREPRINT_YEAR_TOLERANCE) return false;
    }
    const aa = extractLastNames(a.author), ba = extractLastNames(b.author);
    if (aa.size && ba.size) {
      let inter = 0; for (const n of aa) if (ba.has(n)) inter++;
      if (inter / Math.max(aa.size, ba.size) < 0.3) return false;
    }
    return true;
  }

  function mergeMetadata(primary, secondary) {
    const merged = { ...primary };
    for (const [k, v] of Object.entries(secondary)) {
      if (k.startsWith("_")) continue;
      if (!merged[k] && v) merged[k] = v;
    }
    // When a preprint (primary) is merged with its published version
    // (secondary), trust the published venue for bibliographic fields —
    // above all `year`, which on a preprint is the earlier submission year.
    if (isPreprint(primary) && !isPreprint(secondary)) {
      for (const f of PUBLISHED_PREFERRED_FIELDS) {
        if (secondary[f]) merged[f] = secondary[f];
      }
    }
    merged._arxiv_id = primary._arxiv_id || secondary._arxiv_id || "";
    merged.author = preferredAuthor(merged.author || primary.author, secondary.author || "");
    merged._source = `${primary._source || ""}+${secondary._source || ""}`;
    return merged;
  }

  function bestMatch(candidates, queryTitle) {
    let best = null, bestScore = 0, bestRank = -1;
    for (const c of candidates) {
      const s = lookupTitleSimilarity(queryTitle, c.title || "");
      const rank = titleMatchRank(queryTitle, c.title || "");
      if (rank > bestRank || (rank === bestRank && s > bestScore)) {
        bestScore = s; bestRank = rank; best = c;
      }
    }
    return best && bestScore >= MIN_TITLE_SIM ? best : null;
  }

  // ─── Venue abbreviation ──────────────────────────────────────────────
  const VENUE_ABBREVIATIONS = {
    "advances in neural information processing systems": "NeurIPS",
    "neural information processing systems": "NeurIPS",
    "international conference on machine learning": "ICML",
    "international conference on learning representations": "ICLR",
    "association for computational linguistics": "ACL",
    "conference on empirical methods in natural language processing": "EMNLP",
    "north american chapter of the association for computational linguistics": "NAACL",
    "ieee conference on computer vision and pattern recognition": "CVPR",
    "computer vision and pattern recognition": "CVPR",
    "ieee international conference on computer vision": "ICCV",
    "international conference on computer vision": "ICCV",
    "european conference on computer vision": "ECCV",
    "aaai conference on artificial intelligence": "AAAI",
    "international joint conference on artificial intelligence": "IJCAI",
    "acm sigkdd international conference on knowledge discovery and data mining": "KDD",
    "international conference on very large data bases": "VLDB",
    "very large data bases": "VLDB",
    "acm sigmod international conference on management of data": "SIGMOD",
    "ieee transactions on pattern analysis and machine intelligence": "TPAMI",
    "journal of machine learning research": "JMLR",
    "artificial intelligence": "AI",
    "transactions on graphics": "TOG",
    "acm computing surveys": "CSUR",
    "ieee transactions on neural networks and learning systems": "TNNLS",
    "ieee transactions on image processing": "TIP",
    "ieee transactions on signal processing": "TSP",
    "nature machine intelligence": "Nat. Mach. Intell.",
    "international conference on acoustics, speech and signal processing": "ICASSP",
    "acm conference on human factors in computing systems": "CHI",
    "usenix security symposium": "USENIX Security",
    "ieee symposium on security and privacy": "IEEE S&P",
    "acm conference on computer and communications security": "CCS",
    "international world wide web conference": "WWW",
    "conference on machine learning and systems": "MLSys",
    "machine learning and systems": "MLSys",
    "ieee/acm international symposium on code generation and optimization": "CGO",
    "international symposium on code generation and optimization": "CGO",
    "usenix symposium on operating systems design and implementation": "OSDI",
    "operating systems design and implementation": "OSDI",
    "international conference on architectural support for programming languages and operating systems": "ASPLOS",
    "architectural support for programming languages and operating systems": "ASPLOS",
  };

  function abbreviateVenue(name) {
    if (!name) return name;
    const key = name.toLowerCase().replace(/[^a-z0-9\s&,]/g, "").trim();
    for (const [full, abbr] of Object.entries(VENUE_ABBREVIATIONS)
      .sort(([a], [b]) => b.length - a.length)) {
      if (key.includes(full)) return abbr;
    }
    return name;
  }

  function expandVenue(name) {
    if (!name) return name;
    const upper = name.toUpperCase().trim();
    for (const [full, abbr] of Object.entries(VENUE_ABBREVIATIONS)) {
      if (upper === abbr.toUpperCase()) {
        return full.replace(/\b\w/g, c => c.toUpperCase());
      }
    }
    return name;
  }

  // ─── Note cleaning ───────────────────────────────────────────────────
  // Reference managers (Zotero, Mendeley, Scopus exports, …) dump their own
  // bookkeeping into `note` / `annote`. It is never part of the citation and
  // shows up verbatim in the compiled bibliography, so offer to strip it.
  // Keys are matched case-insensitively; `_` also matches the LaTeX-escaped
  // `\_` that managers write, and a space matches any run of whitespace.
  const NOTE_JUNK_KEYS = [
    "read_status_date",
    "read_status",
    "citation key",
    "kerkocite.itemalsoknownas",
    "zscc",
    "mag id",
    "tex.ids",
    "export date",
    "cited by",
    "cited references",
    "correspondence address",
    "art. no",
    "coden",
  ];

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  const NOTE_JUNK_KEY_RE = new RegExp(
    "(?:^|(?<=[\\s;,]))(?:" +
      NOTE_JUNK_KEYS.map(k => escapeRegExp(k).replace(/_/g, "\\\\?_").replace(/ /g, "\\s+")).join("|") +
      ")\\s*:",
    "gi"
  );

  /**
   * Strip reference-manager bookkeeping (`Read_Status: Read`, `ZSCC: 0`, …)
   * from a note value, keeping any prose the user actually wrote. A junk
   * value ends at the next junk key, the next newline, or the end of the note
   * — whichever comes first — because BibTeX parsing may have collapsed the
   * manager's line breaks into spaces.
   */
  function cleanNote(note) {
    if (!note) return "";
    const text = String(note);
    NOTE_JUNK_KEY_RE.lastIndex = 0;
    const starts = [];
    let m;
    while ((m = NOTE_JUNK_KEY_RE.exec(text)) !== null) starts.push(m.index);
    if (!starts.length) return text.trim();

    let kept = "";
    let cursor = 0;
    for (let i = 0; i < starts.length; i++) {
      const start = starts[i];
      if (start < cursor) continue;
      const limit = i + 1 < starts.length ? starts[i + 1] : text.length;
      const nl = text.indexOf("\n", start);
      const end = nl !== -1 && nl < limit ? nl : limit;
      kept += text.slice(cursor, start);
      cursor = end;
    }
    kept += text.slice(cursor);
    return kept.replace(/[\s;,]+/g, " ").trim().replace(/^[;,]+|[;,]+$/g, "").trim();
  }

  /**
   * Return a copy of an entry with note-like fields cleaned; fields left empty
   * by the cleaning are dropped entirely.
   */
  function cleanEntryNotes(entry) {
    const out = { ...entry };
    for (const field of ["note", "annote"]) {
      if (!(field in out)) continue;
      const cleaned = cleanNote(out[field]);
      if (cleaned) out[field] = cleaned;
      else delete out[field];
    }
    return out;
  }

  // ─── Search ──────────────────────────────────────────────────────────
  /**
   * Case-insensitive AND-of-tokens substring match against an entry's title
   * and BibTeX key. Empty/whitespace queries always match. Supports
   * field-qualified tokens `title:foo` and `id:bar` for power users.
   */
  function entryMatchesQuery(entry, query) {
    if (!query) return true;
    const q = String(query).trim().toLowerCase();
    if (!q) return true;
    const title = stripLatex(entry.title || "").toLowerCase();
    const id = (entry.entry_id || entry.ID || "").toLowerCase();
    const haystack = `${id} ${title}`;
    const tokens = q.split(/\s+/).filter(Boolean);
    return tokens.every(tok => {
      if (tok.startsWith("title:")) return title.includes(tok.slice(6));
      if (tok.startsWith("id:") || tok.startsWith("key:"))
        return id.includes(tok.slice(tok.indexOf(":") + 1));
      return haystack.includes(tok);
    });
  }

  // ─── Project citation scanning ───────────────────────────────────────
  const PROJECT_TEXT_EXTENSIONS = new Set([
    ".tex", ".aux", ".md", ".markdown", ".rmd", ".txt", ".sty", ".cls",
    ".html", ".htm", ".ipynb", ".json", ".yaml", ".yml", ".rst", ".py", ".js",
  ]);

  // LaTeX/BibLaTeX citation commands. The command name is matched broadly
  // after \\cite (for example \\citep, \\citet, and \\citeauthor), plus the
  // common prefixed BibLaTeX variants such as \\autocite and \\parencite.
  const CITATION_COMMAND_RE = /(?:\\(?:Cite|cite|nocite|fullcite|bibentry)[a-zA-Z]*\*?|\\(?:auto|foot|paren|text|smart)cite[a-zA-Z]*\*?)(?:\[[^\]]*\])*\s*\{([^}]*)}/g;
  const PANDOC_CITATION_RE = /\[@([^\]]+)\]/g;

  function extractCitationKeys(text) {
    const keys = new Set();
    const addRawKeys = (raw) => {
      String(raw || "")
        .split(/[,;]+/)
        .forEach((part) => {
          const key = part.trim().replace(/^[{\[@']+|[}\]']+$/g, "").trim();
          if (key) keys.add(key.toLowerCase());
        });
    };

    for (const match of String(text || "").matchAll(CITATION_COMMAND_RE))
      addRawKeys(match[1]);
    for (const match of String(text || "").matchAll(PANDOC_CITATION_RE))
      addRawKeys(match[1]);

    return keys;
  }

  function isProjectTextFile(filePath) {
    const normalized = String(filePath || "").replace(/\\/g, "/");
    if (/(^|\/)__MACOSX(\/|$)/i.test(normalized)) return false;
    const name = normalized.split("/").pop() || "";
    const dot = name.lastIndexOf(".");
    if (!name || name.startsWith(".") || dot < 1) return false;
    return PROJECT_TEXT_EXTENSIONS.has(name.slice(dot).toLowerCase());
  }

  // ─── Public API ──────────────────────────────────────────────────────
  exports.TITLE_MATCH_THRESHOLD = TITLE_MATCH_THRESHOLD;
  exports.MIN_TITLE_SIM = MIN_TITLE_SIM;
  exports.COMPARED_FIELDS = COMPARED_FIELDS;
  exports.VENUE_ABBREVIATIONS = VENUE_ABBREVIATIONS;

  exports.stripLatex = stripLatex;
  exports.normalizeTitle = normalizeTitle;
  exports.parseBib = parseBib;
  exports.entriesToBib = entriesToBib;
  exports.tokenSortRatio = tokenSortRatio;
  exports.titleSimilarity = titleSimilarity;
  exports.normalizeText = normalizeText;
  exports.normalizeAuthorSet = normalizeAuthorSet;
  exports.normalizePages = normalizePages;
  exports.compareAuthors = compareAuthors;
  exports.compareField = compareField;
  exports.compareEntry = compareEntry;
  exports.fieldDiffsForNeedsReview = fieldDiffsForNeedsReview;
  exports.crossrefToStandard = crossrefToStandard;
  exports.ssToStandard = ssToStandard;
  exports.openAlexToStandard = openAlexToStandard;
  exports.extractLastNames = extractLastNames;
  exports.isPreprint = isPreprint;
  exports.isSamePaper = isSamePaper;
  exports.mergeMetadata = mergeMetadata;
  exports.bestMatch = bestMatch;
  exports.abbreviateVenue = abbreviateVenue;
  exports.expandVenue = expandVenue;
  exports.isTruncatedAuthor = isTruncatedAuthor;
  exports.isAbbreviatedAuthors = isAbbreviatedAuthors;
  exports.preferredAuthor = preferredAuthor;
  exports.baseTitle = baseTitle;
  exports.lookupTitleVariants = lookupTitleVariants;
  exports.lookupTitleSimilarity = lookupTitleSimilarity;
  exports.titleMatchRank = titleMatchRank;
  exports.inferEntryType = inferEntryType;
  exports.upgradeMiscEntry = upgradeMiscEntry;
  exports.completeAuthors = completeAuthors;
  exports.applyBibStyle = applyBibStyle;
  exports.cleanNote = cleanNote;
  exports.cleanEntryNotes = cleanEntryNotes;
  exports.NOTE_JUNK_KEYS = NOTE_JUNK_KEYS;
  exports.entryMatchesQuery = entryMatchesQuery;
  exports.PROJECT_TEXT_EXTENSIONS = PROJECT_TEXT_EXTENSIONS;
  exports.extractCitationKeys = extractCitationKeys;
  exports.isProjectTextFile = isProjectTextFile;

})(typeof module !== "undefined" && module.exports ? module.exports : (window.BibLib = {}));