import { chromium } from "playwright"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

const input = resolve("docs/architecture.html")
const output = resolve("docs/architecture.pdf")
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })
  await page.goto(pathToFileURL(input).href, { waitUntil: "load" })
  await page.pdf({
    path: output,
    format: "A4",
    printBackground: true,
    preferCSSPageSize: true,
    displayHeaderFooter: true,
    headerTemplate: "<div style='font-size:8px;width:100%;padding:0 12mm;color:#61777a'>OpenCode Web × Skill Store · Core Technical Architecture</div>",
    footerTemplate: "<div style='font-size:8px;width:100%;padding:0 12mm;color:#61777a;text-align:right'><span class='pageNumber'></span> / <span class='totalPages'></span></div>",
    margin: { top: "14mm", right: "12mm", bottom: "14mm", left: "12mm" },
  })
} finally {
  await browser.close()
}
console.log("Generated docs/architecture.pdf")
