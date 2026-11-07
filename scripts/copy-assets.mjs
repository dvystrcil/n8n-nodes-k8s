// Copy the non-TS files n8n loads next to the compiled node (icons, codex).
import { cpSync, globSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

for (const file of globSync("src/**/*.{svg,json}")) {
	const dest = file.replace(/^src\//, "dist/");
	mkdirSync(dirname(dest), { recursive: true });
	cpSync(file, dest);
}
