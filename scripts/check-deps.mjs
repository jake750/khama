// فحص سريع قبل npm run dev (T-55): كل اعتمادية في package.json مثبّتة فعلًا في node_modules.
// حدث أن غابت حزمة موجودة في package-lock.json فسقط vite برسالة غامضة؛ هنا رسالة واضحة وحلّها.
import { existsSync, readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
const missing = names.filter((n) => !existsSync(new URL(`../node_modules/${n}/package.json`, import.meta.url)));
const [major] = process.versions.node.split(".").map(Number);
const want = Number(/\d+/.exec(pkg.engines?.node ?? "0")?.[0] ?? 0);

if (major < want) {
  console.error(`Khama needs Node.js ${want} or newer (you have ${process.versions.node}).`);
  process.exit(1);
}
if (missing.length) {
  console.error(`Missing packages: ${missing.join(", ")}\nRun: npm ci`);
  process.exit(1);
}
