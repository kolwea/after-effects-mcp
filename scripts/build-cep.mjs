// Assembles the CEP extension into build/cep: panel files, the ExtendScript core, and a vendored copy of ws.
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "build", "cep");

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(root, "cep"), out, { recursive: true });
fs.mkdirSync(path.join(out, "host"), { recursive: true });
fs.copyFileSync(path.join(root, "src", "scripts", "bridge-core.jsx"), path.join(out, "host", "bridge-core.jsx"));
fs.cpSync(path.join(root, "node_modules", "ws"), path.join(out, "node_modules", "ws"), { recursive: true });

console.log(`CEP extension built at ${out}`);
