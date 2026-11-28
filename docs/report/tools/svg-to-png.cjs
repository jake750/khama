// Renders hand-drawn SVG figures of the report (docs/report/figures/*.svg) to PNG at 2x, with the local Chrome.
// usage: NODE_PATH=<folder with puppeteer>/node_modules node svg-to-png.cjs <in.svg> [out.png]
// puppeteer comes with @mermaid-js/mermaid-cli, which md-to-docx.cjs needs anyway. Chrome lays out Arabic correctly,
// which matplotlib does not without extra packages.
const fs = require("fs");
const path = require("path");
const NODE_MODULES = (process.env.NODE_PATH || "").split(path.delimiter).filter(Boolean)[0] || path.join(process.cwd(), "node_modules");
const puppeteer = require(path.join(NODE_MODULES, "puppeteer"));
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";

(async () => {
  const [src, dst = src.replace(/\.svg$/i, ".png")] = process.argv.slice(2);
  const svg = fs.readFileSync(src, "utf8");
  const w = Number(/width="(\d+)"/.exec(svg)[1]), h = Number(/height="(\d+)"/.exec(svg)[1]);
  const browser = await puppeteer.launch({ executablePath: CHROME, args: ["--no-sandbox"], headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 2 });
  await page.setContent(`<!doctype html><html><body style="margin:0">${svg}</body></html>`);
  await page.screenshot({ path: dst, clip: { x: 0, y: 0, width: w, height: h } });
  await browser.close();
  console.log("wrote", dst);
})();
