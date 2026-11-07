#!/usr/bin/env node
// Dependency gate: re-runs the AC1-style audit on every change to what ships.
//
//   node scripts/audit-deps.mjs                 check against deps-baseline.json
//   node scripts/audit-deps.mjs --update        rewrite the baseline (then commit it)
//   [--root DIR] [--baseline FILE]
//
// What ships is dist/ plus the PRODUCTION dependency tree from
// package-lock.json (dev dependencies are never copied into the image).
//
// Per production package it records the version, the licence, and which
// files use each capability:
//   network  http/https/net/tls/dns/dgram/undici/ws/node-fetch, fetch(), WebSocket
//   exec     child_process, vm, eval(), new Function()
//   fs       fs, fs/promises
//   env      process.env
// Any difference from the committed baseline fails, so a dependency bump
// cannot land until someone re-baselines it and the capability diff is in the
// PR for review. That is the point: the check fails closed.
//
// Always fatal, --update or not:
//   - a production package with an install script;
//   - a licence outside the allow-list;
//   - a lockfile package that is not installed;
//   - the node's own dist/ requiring anything but client-node, node:fs or its
//     own files, or using network/exec/env directly (n8n-workflow must be a
//     type-only import: it does not resolve from N8N_CUSTOM_EXTENSIONS);
//   - a prompt-injection shape in any dist/ text (the description lint from
//     homelab's mcp-trust-audit.py LINT_PATTERNS, vendored below).
//
// The last line is DEPS-AUDIT-OK only when everything passed.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : dflt;
};
const root = opt("--root", process.cwd());
const baselineFile = opt("--baseline", join(root, "deps-baseline.json"));
const update = args.includes("--update");

const LICENCES = new Set(["MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "BlueOak-1.0.0", "CC0-1.0", "Unlicense", "PSF-2.0", "Python-2.0"]);

const mod = (names) =>
	new RegExp(
		`(?:\\brequire\\s*\\(\\s*|\\bfrom\\s*|\\bimport\\s*\\(\\s*|\\bimport\\s+)['"\`](?:node:)?(?:${names})['"\`]`,
	);
const CAPABILITIES = {
	network: [mod("https?|http2|net|tls|dns|dns/promises|dgram|undici|ws|isomorphic-ws|node-fetch"), /\bfetch\s*\(/, /\bnew\s+WebSocket\b/, /\bXMLHttpRequest\b/],
	exec: [mod("child_process|vm|worker_threads"), /(?<![\w$.])eval\s*\(/, /\bnew\s+Function\s*\(/],
	fs: [mod("fs|fs/promises")],
	env: [/\bprocess\.env\b/, /\bprocess\s*\[\s*['"]env['"]\s*\]/],
};

// homelab bin/mcp-trust-audit.py LINT_PATTERNS (2026-11-06), vendored: the
// homelab repo is private, and this fork's CI must run on its own.
const LINT = [
	["CRIT", /ignore\s+(all\s+)?(previous|the\s+above|prior)\s+(instructions?|context)/i, "ignore-previous-instructions injection"],
	["CRIT", /<\|im_(start|end)\|>/, "ChatML token injection"],
	["CRIT", /<\/?(system|assistant|user)>/, "fake chat-template tag"],
	["CRIT", /^\s*system:\s/im, "fake SYSTEM: prefix"],
	["WARN", /\byou\s+(must|are\s+required\s+to|are\s+now)\b/i, "imperative directive to the model"],
	["WARN", /\b(act|behave|respond)\s+as\s+(a|an|the)\s+(admin|root|developer|security)/i, "role-shift attempt"],
	["WARN", /\b(disregard|forget)\s+(your|the|all)\s+(prior|previous|earlier)/i, "soft-form of ignore-previous"],
];

const OWN_REQUIRES = new Set(["@kubernetes/client-node", "node:fs"]);

const fatal = [];

function walk(dir, skipNested, out = []) {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		const st = statSync(p);
		if (st.isDirectory()) {
			if (skipNested && name === "node_modules") continue;
			walk(p, skipNested, out);
		} else if (/\.(c|m)?js$/.test(name)) out.push(p);
	}
	return out;
}

function capabilitiesOf(dir) {
	const caps = {};
	for (const file of walk(dir, true).sort()) {
		const text = readFileSync(file, "utf8");
		for (const [cap, patterns] of Object.entries(CAPABILITIES)) {
			if (patterns.some((re) => re.test(text))) (caps[cap] ??= []).push(relative(dir, file));
		}
	}
	return Object.fromEntries(Object.entries(caps).sort(([a], [b]) => a.localeCompare(b)));
}

function licenceOk(expr) {
	if (typeof expr !== "string") return false;
	const tokens = expr.replace(/[()]/g, " ").split(/\s+/).filter(Boolean);
	const ids = tokens.filter((t) => t !== "OR" && t !== "AND");
	if (ids.length === 0) return false;
	return tokens.includes("OR") && !tokens.includes("AND") ? ids.some((t) => LICENCES.has(t)) : ids.every((t) => LICENCES.has(t));
}

// ---- production dependency tree --------------------------------------------
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const current = {};
for (const [path, meta] of Object.entries(lock.packages ?? {})) {
	if (path === "" || meta.dev || meta.link) continue;
	const key = path.replace(/^node_modules\//, "");
	const dir = join(root, path);
	if (!existsSync(dir)) {
		if (meta.optional) continue;
		fatal.push(`${key} is in the lockfile but not installed (run npm ci)`);
		continue;
	}
	if (meta.hasInstallScript) fatal.push(`${key}@${meta.version} has an install script`);
	if (!licenceOk(meta.license)) fatal.push(`${key}@${meta.version} licence "${meta.license}" is not allowed`);
	current[key] = { version: meta.version, license: meta.license, capabilities: capabilitiesOf(dir) };
}

// ---- the node's own shipped code -------------------------------------------
const dist = join(root, "dist");
if (!existsSync(dist)) fatal.push("dist/ is missing: build before auditing");
else {
	for (const file of walk(dist, false)) {
		const rel = relative(root, file);
		const text = readFileSync(file, "utf8");
		for (const m of text.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
			if (!m[1].startsWith(".") && !OWN_REQUIRES.has(m[1])) fatal.push(`${rel} requires "${m[1]}"`);
		}
		for (const cap of ["network", "exec", "env"]) {
			if (CAPABILITIES[cap].some((re) => re.test(text))) fatal.push(`${rel} uses ${cap}`);
		}
	}
	for (const file of [...walk(dist, false), ...readdirSync(dist, { recursive: true }).filter((f) => f.endsWith(".json")).map((f) => join(dist, f))]) {
		const text = readFileSync(file, "utf8");
		for (const [sev, re, label] of LINT) {
			const m = text.match(re);
			if (m) fatal.push(`${relative(root, file)}: ${sev} ${label}: "${m[0]}"`);
		}
	}
}

// ---- compare with the baseline ---------------------------------------------
const sorted = Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b)));
const diffs = [];
if (update) {
	if (fatal.length === 0) {
		writeFileSync(baselineFile, JSON.stringify({ comment: "node scripts/audit-deps.mjs --update; review the diff before committing", packages: sorted }, null, 2) + "\n");
		console.log(`wrote ${baselineFile}: ${Object.keys(sorted).length} production packages`);
	}
} else if (!existsSync(baselineFile)) {
	fatal.push(`no baseline at ${baselineFile}: run with --update and review it`);
} else {
	const base = JSON.parse(readFileSync(baselineFile, "utf8")).packages;
	for (const key of Object.keys(base)) if (!(key in current)) diffs.push(`${key}: removed`);
	for (const [key, now] of Object.entries(sorted)) {
		const was = base[key];
		if (!was) {
			diffs.push(`${key}: new package ${now.version}`);
			for (const [cap, files] of Object.entries(now.capabilities)) for (const f of files) diffs.push(`${key}: +${cap} ${f}`);
			continue;
		}
		if (was.version !== now.version) diffs.push(`${key}: version ${was.version} -> ${now.version}`);
		if (was.license !== now.license) diffs.push(`${key}: licence ${was.license} -> ${now.license}`);
		for (const cap of new Set([...Object.keys(was.capabilities), ...Object.keys(now.capabilities)])) {
			const a = new Set(was.capabilities[cap] ?? []);
			const b = new Set(now.capabilities[cap] ?? []);
			for (const f of b) if (!a.has(f)) diffs.push(`${key}: +${cap} ${f}`);
			for (const f of a) if (!b.has(f)) diffs.push(`${key}: -${cap} ${f}`);
		}
	}
}

for (const f of fatal) console.log(`FAIL ${f}`);
for (const d of diffs) console.log(`DIFF ${d}`);
if (diffs.length) console.log(`${diffs.length} change(s) from ${relative(root, baselineFile)}: review them, then re-run with --update and commit the baseline`);
if (fatal.length || diffs.length) process.exit(1);
console.log(`${Object.keys(sorted).length} production packages match the baseline; dist/ clean`);
console.log("DEPS-AUDIT-OK");
