// How a repo's plans and specs depend on each other, and which still have open questions,
// for the roadmap view. Reads the same files src/projects.ts found (each project's main
// file and the other markdown in its folder) and never anything else.
//
// Dependencies come from lines that start "Depends on", "Requires" or "Blocked by":
//   Caddis       **Depends on:** project-dc-04-page-shell.md, project-dc-05-stat-cards.md
//   anything     Requires [Albums](../002-albums/spec.md) / Blocked by: Photo tags
// A ref only counts when it resolves to another spec in the same repo (its file, folder,
// slug or exact name), so prose like "Requires native rebuild" adds nothing.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Project } from './types.js';

const DEP_LINE = /^\s*(?:[-*+]\s+)?[*_]{0,2}\s*(?:depends\s+on|requires|blocked\s+by)\s*[*_]{0,2}\s*:?\s*[*_]{0,2}\s*:?\s*(.*)$/i;
const NOTHING = /^(none|nothing|n\/?a|-+|—|tbd)\.?$/i;

/** What one dependency line points at: link targets, and items that may be a file, folder or name. */
export interface DepRefs {
  links: string[];
  items: string[];
}

/** Every Depends on / Requires / Blocked by line outside code fences, split into refs. */
export function dependencyRefs(text: string): DepRefs {
  const out: DepRefs = { links: [], items: [] };
  let fence = false;
  const lines = text.split('\n').map((l) => l.replace(/^\s*>\s?/, ''));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const m = DEP_LINE.exec(line);
    if (!m || m[1] === undefined) continue;
    let rest = m[1];
    // A long Depends on line wraps: "**Depends on**: `a.md`, `b.md`,\n`c.md` (why)". The
    // paragraph runs on until a blank line, a heading, a bullet or the next "**Key**:" line.
    while (i + 1 < lines.length && /\S/.test(lines[i + 1] as string) && !/^\s*(#|[-*+]\s|\d+[.)]\s|\*\*[^*]+\*\*\s*:|\*\*[^*]+:\*\*|```|~~~|\|)/.test(lines[i + 1] as string) && !DEP_LINE.test(lines[i + 1] as string)) {
      rest += ' ' + lines[++i];
    }
    // [Albums](../002-albums/spec.md): the target is exact, the text may be a name too.
    rest = rest.replace(/\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_, t: string, u: string) => {
      out.links.push(u);
      if (t.trim()) out.items.push(t.trim());
      return ',';
    });
    rest = rest.replace(/`([^`]+)`/g, (_, c: string) => {
      out.items.push(c.trim());
      return ',';
    });
    for (const part of rest.split(/,|;|\s+and\s+|\s+&\s+|\s\+\s/i)) {
      const t = part.replace(/[*_]/g, '').replace(/\([^)]*\)/g, '').replace(/[.:]+$/, '').trim();
      if (t && !NOTHING.test(t)) out.items.push(t);
    }
  }
  return out;
}

/**
 * Questions still open: bullets under "## Open Questions" that carry no answer, plus Spec
 * Kit's [NEEDS CLARIFICATION: ...] markers. Caddis tags an answered one "(owner, 2026-11-06)".
 */
export function openQuestions(text: string): number {
  const lines = text.split('\n');
  let n = (text.match(/\[NEEDS CLARIFICATION\b/gi) ?? []).length;
  const start = lines.findIndex((l) => /^#{2,3}\s+open\s+questions\b/i.test(l.trim()));
  if (start < 0) return n;
  const level = (/^(#+)/.exec(lines[start]!.trim())?.[1] ?? '##').length;
  let fence = false;
  for (const l of lines.slice(start + 1)) {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    if (fence) continue;
    const h = /^(#{1,6})\s/.exec(l);
    if (h && (h[1] as string).length <= level) break;
    const b = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(l); // top level only: sub-bullets are detail
    if (!b) continue;
    const item = (b[1] ?? '').trim();
    if (!item || NOTHING.test(item.replace(/[*_]/g, ''))) continue;
    if (/^\[[xX]\]/.test(item) || /^~~/.test(item)) continue;
    if (/^\**(decided|resolved|answered|done)\b/i.test(item)) continue;
    if (/\((?:owner|agent|[\w.-]+),\s*\d{4}-\d{2}-\d{2}\)/.test(item)) continue;
    n++;
  }
  return n;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** The names a spec can be referred to by: slug, folder, number, title. */
function keysOf(p: Project): string[] {
  const keys = [norm(p.name)];
  const slug = path.basename(p.file, '.md');
  if (p.source === 'caddis' || p.source === 'claude-projects') {
    keys.push(norm(slug), norm(slug.replace(/^(project|task)-/, '')));
  } else {
    // A framework spec is its folder: specs/002-albums, openspec/changes/add-tags.
    const folder = path.basename(path.dirname(p.file));
    keys.push(norm(folder), norm(folder.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/^\d+-/, '')));
    const num = /^(\d{3,})-/.exec(folder)?.[1];
    if (num) keys.push(num);
  }
  return [...new Set(keys.filter(Boolean))];
}

function read(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** A ref that looks like a path: its last meaningful segment, without .md ("specs/002-albums/spec.md" is 002-albums). */
function pathKey(ref: string): string {
  const parts = ref.replace(/[#?].*$/, '').split(/[\\/]/).filter((x) => x && x !== '.' && x !== '..');
  let last = parts.pop() ?? '';
  // The framework's fixed file names say nothing; the folder above them names the spec.
  if (/^(spec|tasks|plan|proposal|design|requirements|readme)\.md$/i.test(last) && parts.length) last = parts.pop() as string;
  return last.replace(/\.md$/i, '');
}

/**
 * Sets `dependsOn` (ids of other specs in the same repo) and `questions` on each project.
 * Each project is parsed on its own: one that fails just has no links (degrade, don't crash).
 */
export function linkSpecs(projects: Project[], readFile: (f: string) => string = read): Project[] {
  try {
    return link(projects, readFile);
  } catch {
    return projects; // the roadmap shows the specs unconnected rather than the scan failing
  }
}

function link(projects: Project[], readFile: (f: string) => string): Project[] {
  const byKey = new Map<string, Project>();
  const byDir = new Map<string, Project>();
  // Earlier entries win a shared key: projects.ts lists plans before framework specs.
  for (const p of projects) {
    for (const k of keysOf(p)) if (!byKey.has(k)) byKey.set(k, p);
    if (p.source !== 'caddis' && p.source !== 'claude-projects') byDir.set(path.dirname(p.file), p);
  }
  const byFile = new Map(projects.flatMap((p) => [p.file, ...(p.docs ?? [])].map((f) => [f, p] as const)));
  return projects.map((p) => {
    try {
      const files = [...new Set([p.file, ...(p.docs ?? [])])].filter((f) => /\.md$/i.test(f)).slice(0, 12);
      const deps = new Set<string>();
      let questions = 0;
      for (const f of files) {
        const text = readFile(f);
        if (!text) continue;
        questions += openQuestions(text);
        const refs = dependencyRefs(text);
        const add = (q: Project | undefined) => {
          if (q && q.id !== p.id) deps.add(q.id);
        };
        for (const link of refs.links) {
          if (/^[a-z]+:/i.test(link)) continue; // http:, vscode:: not a file in the repo
          let target = link.replace(/#.*$/, '');
          try {
            target = decodeURIComponent(target);
          } catch {
            /* a malformed %-escape: try the link as written */
          }
          const abs = path.resolve(path.dirname(f), target);
          add(byFile.get(abs) ?? byDir.get(abs) ?? byDir.get(path.dirname(abs)) ?? byKey.get(norm(pathKey(link))));
        }
        for (const item of refs.items) {
          const looksLikePath = /[\\/]|\.md$/i.test(item);
          if (looksLikePath) add(byKey.get(norm(pathKey(item))));
          else add(byKey.get(norm(item.replace(/^the\s+/i, '').replace(/\s+(spec|plan|project|change|feature)$/i, ''))) ?? byKey.get(norm(item)));
        }
      }
      const out: Project = { ...p };
      if (deps.size) out.dependsOn = [...deps];
      if (questions) out.questions = questions;
      return out;
    } catch {
      return p;
    }
  });
}
