/**
 * codemap index validation — part of the codemap kit by Rateb Seirawan.
 *
 * Catches the corruption classes that pass as valid YAML:
 *   1. unparseable YAML (a reader would silently drop the unit)
 *   2. a collapsed scalar: `- status must be draft: x` parses as a one-key MAP,
 *      not a string, truncating the text from every lookup
 *   3. a missing required key, or `unit` / `path` disagreeing with the file's place
 *   4. leaked tool-wrapper tags (`</content>`) an agent echoed into the body
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { type CodemapLane, ROOT, unitFromYamlRel, unitSourcePath } from "./core"

export interface Finding {
	file: string
	message: string
}

const LEAKED = /^\s*<\/?(content|parameter|invoke|antml:[a-z_]+)[^>]*>\s*$/

/** Removes leaked wrapper-tag lines in place. Returns how many were dropped. */
export function stripArtifacts(abs: string): number {
	const raw = readFileSync(abs, "utf8")
	const lines = raw.split("\n")
	const kept = lines.filter((l) => !LEAKED.test(l))
	if (kept.length !== lines.length) Bun.write(abs, kept.join("\n"))
	return lines.length - kept.length
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === "object" && !Array.isArray(v)
}

/** Values at a dotted path; `[]` fans out over a list: "operations[].errors". */
function at(doc: unknown, path: string): { where: string; value: unknown }[] {
	let cur: { where: string; value: unknown }[] = [{ where: "", value: doc }]
	for (const seg of path.split(".")) {
		const fan = seg.endsWith("[]")
		const key = fan ? seg.slice(0, -2) : seg
		const next: { where: string; value: unknown }[] = []
		for (const c of cur) {
			if (!isPlainObject(c.value) || !(key in c.value)) continue
			const v = c.value[key]
			const where = c.where ? `${c.where}.${key}` : key
			if (fan && Array.isArray(v)) v.forEach((item, i) => next.push({ where: `${where}[${i}]`, value: item }))
			else if (!fan) next.push({ where, value: v })
		}
		cur = next
	}
	return cur
}

/**
 * Heuristic collapse detector for lists nobody declared: in a list whose items
 * are mostly strings, a one-key map with a scalar value is almost always a
 * string that contained ": ".
 */
function collapsedInMixedLists(node: unknown, where: string, out: string[]): void {
	if (Array.isArray(node)) {
		const strings = node.filter((x) => typeof x === "string").length
		node.forEach((item, i) => {
			if (strings > 0 && isPlainObject(item)) {
				const keys = Object.keys(item)
				if (keys.length === 1 && (typeof item[keys[0]] !== "object" || item[keys[0]] === null))
					out.push(`${where}[${i}] parsed as a map {${keys[0]}: …} among strings: a ": " inside a plain scalar. Quote the whole item or reword with "=" / "—".`)
			}
			collapsedInMixedLists(item, `${where}[${i}]`, out)
		})
	} else if (isPlainObject(node)) {
		for (const [k, v] of Object.entries(node)) collapsedInMixedLists(v, where ? `${where}.${k}` : k, out)
	}
}

export function validateUnitYaml(lane: CodemapLane, yamlRelPath: string): Finding[] {
	const file = yamlRelPath
	const out: Finding[] = []
	const push = (m: string) => out.push({ file, message: m })
	let raw: string
	try {
		raw = readFileSync(join(ROOT, yamlRelPath), "utf8")
	} catch (e) {
		push(`unreadable: ${String(e)}`)
		return out
	}
	raw.split("\n").forEach((l, i) => {
		if (LEAKED.test(l)) push(`line ${i + 1}: leaked tool tag "${l.trim()}"`)
	})
	let doc: unknown
	try {
		doc = Bun.YAML.parse(raw)
	} catch (e) {
		push(`YAML does not parse: ${String(e).split("\n")[0]}`)
		return out
	}
	if (!isPlainObject(doc)) {
		push("top level must be a mapping")
		return out
	}
	const unit = unitFromYamlRel(lane, yamlRelPath)
	for (const k of new Set(["unit", "path", "description", ...(lane.required ?? [])]))
		if (!(k in doc) || doc[k] === null || doc[k] === "") push(`missing required key "${k}"`)
	if (unit && doc.unit !== undefined && doc.unit !== unit) push(`unit: "${doc.unit}" but the file's place says "${unit}"`)
	if (unit && doc.path !== undefined && doc.path !== unitSourcePath(lane, unit))
		push(`path: "${doc.path}" but this unit's source is "${unitSourcePath(lane, unit)}"`)
	if (doc.description !== undefined && typeof doc.description !== "string") push(`description must be a string`)

	const entries = doc[lane.entries_key]
	if (entries !== undefined && entries !== null) {
		if (!Array.isArray(entries)) push(`${lane.entries_key} must be a list`)
		else
			entries.forEach((e, i) => {
				if (!isPlainObject(e)) {
					push(`${lane.entries_key}[${i}] must be a mapping`)
					return
				}
				for (const k of new Set(["name", ...(lane.entry_required ?? [])]))
					if (!(k in e) || e[k] === null || e[k] === "") push(`${lane.entries_key}[${i}] (${String(e.name ?? "?")}) missing "${k}"`)
			})
	}
	for (const path of lane.string_lists ?? [])
		for (const { where, value } of at(doc, path)) {
			if (value === null || value === undefined) continue
			if (!Array.isArray(value)) {
				push(`${where} must be a list of strings`)
				continue
			}
			value.forEach((v, i) => {
				if (typeof v !== "string") push(`${where}[${i}] is ${isPlainObject(v) ? "a map" : typeof v}, must be a string (a ": " inside it? quote the item)`)
			})
		}
	const collapsed: string[] = []
	collapsedInMixedLists(doc, "", collapsed)
	for (const c of collapsed) push(c)
	return out
}

/** Locates the 1-based line of an entry `- name: X` (or the unit top) for Read pointers. */
export function entryLine(raw: string, name: string | null): number {
	if (!name) return 1
	const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	const re = new RegExp(`^\\s*-?\\s*name:\\s*["']?${esc}["']?\\s*$`)
	const lines = raw.split("\n")
	const i = lines.findIndex((l) => re.test(l))
	return i < 0 ? 1 : i + 1
}
