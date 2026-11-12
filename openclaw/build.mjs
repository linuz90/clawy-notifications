// OpenClaw installs packages only from JavaScript, so this strips the types and nothing else: each
// file in dist/ matches its .ts source line for line, which keeps the published code as auditable
// as this repo. Node's own stripper, no dependencies.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const here = new URL("./", import.meta.url);
mkdirSync(new URL("dist", here), { recursive: true });
for (const name of ["index", "route", "seal", "devices", "activity"]) {
  const js = stripTypeScriptTypes(readFileSync(new URL(`${name}.ts`, here), "utf8")).replace(/from "\.\/(\w+)\.ts"/gu, 'from "./$1.js"').replace(/[ \t]+$/gmu, "");
  writeFileSync(new URL(`dist/${name}.js`, here), js);
}
