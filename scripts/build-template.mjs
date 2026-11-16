// 產生給學員的乾淨範本：node scripts/build-template.mjs [輸出資料夾]
// 只放程式與 template/ 裡的範本專用檔，不含你的網址、LIFF ID、開發紀錄或任何資料。
// 前端與後端都直接取自這個專案，所以這裡改了功能，重跑一次範本就跟上。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.resolve(process.argv[2] || path.join(root, "..", "line_group_board_template"));
const keep = new Set([".git"]);

fs.mkdirSync(out, { recursive: true });
for (const name of fs.readdirSync(out)) if (!keep.has(name)) fs.rmSync(path.join(out, name), { recursive: true });

const copy = (from, to) => {
  fs.mkdirSync(path.dirname(path.join(out, to)), { recursive: true });
  fs.cpSync(path.join(root, from), path.join(out, to), { recursive: true });
};
for (const name of fs.readdirSync(path.join(root, "template"))) copy(path.join("template", name), name);
copy("api/src/index.js", "src/index.js");
copy("assets", "public/assets");
copy("version.json", "public/version.json");

let html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const replaceOnce = (pattern, replacement, label) => {
  const before = html;
  html = html.replace(pattern, replacement);
  if (html === before) throw new Error("範本產生失敗，找不到：" + label);
};
// 站台設定改成向自己的 Worker 拿，學員不必改程式
replaceOnce(/<script>\s*window\.SITE_SETUP = \{[\s\S]*?\};\s*<\/script>/, '<script src="/config.js"></script>', "SITE_SETUP 區塊");
replaceOnce(/const DEFAULT_OWNER_GAS_URL =\s*"[^"]*";/, 'const DEFAULT_OWNER_GAS_URL = "";', "DEFAULT_OWNER_GAS_URL");
fs.writeFileSync(path.join(out, "public/index.html"), html);

// 最後再檢查一次，原作者的設定一個都不能留
const leaks = ["vainbook.workers.dev", "vainbook.github.io", "2010984505", "script.google.com/macros"];
const scan = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  if (entry.name === ".git") return [];
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return scan(full);
  const text = fs.readFileSync(full, "utf8");
  return leaks.filter(word => text.includes(word)).map(word => path.relative(out, full) + " 含有 " + word);
});
const found = scan(out);
if (found.length) throw new Error("範本裡還有原作者的設定：\n" + found.join("\n"));
console.log("範本已產生：" + out);
