// Installs build/cep as a per-user CEP extension and enables loading unsigned extensions.
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "build", "cep");
const BUNDLE_ID = "com.aemcp.bridge";

if (!fs.existsSync(path.join(source, "CSXS", "manifest.xml"))) {
  console.error("build/cep is missing. Run `npm run build` first.");
  process.exit(1);
}

const extensionsDir =
  process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support", "Adobe", "CEP", "extensions")
  : process.platform === "win32" ? path.join(process.env.APPDATA, "Adobe", "CEP", "extensions")
  : null;
if (!extensionsDir) {
  console.error("Unsupported platform for CEP.");
  process.exit(1);
}

const target = path.join(extensionsDir, BUNDLE_ID);
fs.mkdirSync(extensionsDir, { recursive: true });
fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(source, target, { recursive: true });
console.log(`Installed to ${target}`);

// CEP refuses unsigned extensions unless PlayerDebugMode is set. AE 2026 runs CEP 12; 11 covers older AE.
for (const v of ["11", "12"]) {
  if (process.platform === "darwin") {
    execFileSync("defaults", ["write", `com.adobe.CSXS.${v}`, "PlayerDebugMode", "1"]);
  } else {
    execFileSync("reg", ["add", `HKCU\\Software\\Adobe\\CSXS.${v}`, "/v", "PlayerDebugMode", "/t", "REG_SZ", "/d", "1", "/f"]);
  }
}
console.log("PlayerDebugMode enabled for CSXS 11 and 12.");
console.log("Restart After Effects, then open Window > Extensions > MCP Bridge and dock it.");
