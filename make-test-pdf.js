const fs = require("fs");
const os = require("os");
const path = require("path");
const { PDFDocument } = require("pdf-lib");

(async () => {
    const out = await PDFDocument.create();
    for (const name of ["front", "back"]) {
        const src = await PDFDocument.load(
            fs.readFileSync(path.join(__dirname, "pdfs", `${name}.pdf`)),
        );
        const [page] = await out.copyPages(src, [0]);
        out.addPage(page);
    }
    const target = path.join(os.tmpdir(), "two-page.pdf");
    fs.writeFileSync(target, await out.save());
    console.log(`Created ${target}`);
})();
