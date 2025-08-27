import * as core from "@actions/core";
import * as github from "@actions/github";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { globby } from "globby";
import * as crypto from "node:crypto";
import { fetch } from "undici";

type OpenAIChatResponse = {
  choices: { message?: { content?: string } }[];
};

type FileBlob = { path: string; size: number; content: string };

function clampBytes(s: string, max: number) {
  const b = Buffer.from(s, "utf8");
  return b.byteLength <= max ? s : b.subarray(0, max).toString("utf8");
}

async function fileExists(p: string) { try { await fs.stat(p); return true; } catch { return false; } }

async function readText(p: string) { return fs.readFile(p, "utf8"); }

async function collect(globsCSV: string): Promise<FileBlob[]> {
  const globs = globsCSV.split(",").map(s => s.trim()).filter(Boolean);
  const paths = await globby(globs, { gitignore: true, absolute: false });
  const out: FileBlob[] = [];
  for (const p of paths) {
    try {
      const st = await fs.stat(p);
      if (st.isFile() && st.size < 1_000_000) {
        out.push({ path: p, size: st.size, content: await readText(p) });
      }
    } catch { /* ignore */ }
  }
  return out;
}

function buildPrompt(args: {
  repo: string;
  schemaFiles: FileBlob[];
  currentERD: string | null;
}) {
  const MAX_SCHEMA_BYTES = 250_000;
  const schemaJoined = args.schemaFiles
    .sort((a, b) => (a.path.includes("db/schema.rb") ? -1 : 0))
    .map(f => `# ${f.path}\n${f.content}`).join("\n\n---\n\n");

  const current = args.currentERD
    ? `CURRENT_ERD:\n${args.currentERD}`
    : "CURRENT_ERD: (none)";

  return `
You are a meticulous database reverse-engineer.

Repository: ${args.repo}

GOAL:
- Generate a **Mermaid ER diagram** for the repository’s database and return it ONLY if it differs from the provided ERD.

STRICT OUTPUT CONTRACT (very important):
- If the CURRENT_ERD is **semantically equivalent** and only differs by formatting, alignment, whitespace, ordering, or trivial label/style differences, output exactly: NO_CHANGE
- Otherwise, output **only** a single Mermaid ERD that begins with: erDiagram
- Do not wrap in backticks. No prose.
- The given CURRENT_ERD may contain backticks and a mermaid delimiter. DO NOT under any circumstance count this as a difference to yours.

MATERIAL CHANGE RULES (what counts as different):
- Added/removed entities (tables)
- Added/removed columns
- Column type/nullable/default changes
- Primary/unique/index constraints changed
- Foreign keys/relationships added/removed
- Relationship cardinality changed (e.g., one-to-many vs many-to-many)
- Entity/column rename **only** if schema clearly implies the rename (not just cosmetic)

NORMALIZATION RULES (to ignore cosmetic diffs):
- Sort entities and attributes alphabetically for stability.
- Normalize whitespace and indentation.
- Ignore comment text and layout/alignment differences.

CRITICAL INSTRUCTION:
- If the CURRENT_ERD is semantically equivalent to the diagram you generate, you must output the literal string: NO_CHANGE.
- Do NOT regenerate or echo the diagram in this case.
- Failure to comply will be treated as an error.

CURRENT ERD:
${current}

SCHEMA SNIPPETS:
${clampBytes(schemaJoined, MAX_SCHEMA_BYTES)}
`.trim();
}

async function callOpenAI(apiKey: string, model: string, prompt: string): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, temperature: 0, messages: [{ role: "user", content: prompt }] })
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenAI API error: ${res.status} ${txt}`);
  }
  const data = (await res.json()) as OpenAIChatResponse;
  const text = data.choices?.[0]?.message?.content?.trim() || "";
  return text.replace(/^```(?:mermaid)?/i, "").replace(/```$/i, "").trim();
}

function normalizeERD(s: string) {
  // Normalization to reduce accidental diffs if model forgets NO_CHANGE
  return s
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .join("\n")
    .toLowerCase();
}

async function run() {
  const ctx = github.context;
  const openai_api_key = core.getInput("openai_api_key", { required: true });
  const model = core.getInput("model");
  const outputPath = core.getInput("output_path");
  const includeModels = core.getInput("include_models") === "true";
  const schemaGlobs = core.getInput("schema_globs");

  const schemaFiles = await collect(schemaGlobs);
  if (schemaFiles.length === 0) {
    core.setFailed("No schema-like files found. Adjust 'schema_globs'.");
    return;
  }

  const currentERD = (await fileExists(outputPath)) ? await readText(outputPath) : null;
  core.info("Detected current ERD as\n" + currentERD);
  const prompt = buildPrompt({
    repo: `${ctx.repo.owner}/${ctx.repo.repo}`,
    schemaFiles,
    currentERD
  });

  const result = await callOpenAI(openai_api_key, model, prompt);
  core.info("Recieved the following response from OpenAI\n" + result);
  if (/^no_change$/i.test(result)) {
    core.info("Model reported NO_CHANGE — ERD is up to date.");
    return; // success
  }

  // If the model returned an ERD, double-check against current with simple normalization
  if (!result.toLowerCase().startsWith("erdiagram")) {
    core.warning("Model did not return NO_CHANGE or an 'erDiagram' block. Treating as material change.");
  }

  const currentNorm = currentERD ? normalizeERD(currentERD) : "";
  const newNorm = normalizeERD(result);

  if (currentNorm === newNorm) {
    core.info("Normalized ERDs match; treating as NO_CHANGE.");
    return; // success
  }

  // Material difference: fail the job and print the expected ERD
  const summary = [
    "### ERD requires update",
    "",
    "The generated ERD differs **materially** from the file in the repo.",
    `Please update \`${outputPath}\` to the following:`,
    "",
    "```mermaid",
    result,
    "```"
  ].join("\n");

  await core.summary.addRaw(summary, true).write();

  // Also echo a compact excerpt into logs for convenience
  core.error(`Material ERD change detected. Update ${outputPath} with the ERD shown in the job summary.`);
  core.setFailed("ERD out of date");
}

run().catch(err => core.setFailed(err.message));

