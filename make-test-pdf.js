const fs = require("fs");
const os = require("os");
const path = require("path");
const { PDFDocument } = require("pdf-lib");

// CR80 portrait in points.
const CR80 = { width: 153, height: 242.64 };

(async () => {
    const original = await PDFDocument.create();
    const cr80 = await PDFDocument.create();

    for (const name of ["front", "back"]) {
        const src = await PDFDocument.load(
            fs.readFileSync(path.join(__dirname, "pdfs", `${name}.pdf`)),
        );

        const [copied] = await original.copyPages(src, [0]);
        original.addPage(copied);

        const [embedded] = await cr80.embedPdf(src, [0]);
        const page = cr80.addPage([CR80.width, CR80.height]);
        page.drawPage(embedded, {
            x: 0,
            y: 0,
            width: CR80.width,
            height: CR80.height,
        });
    }

    const originalTarget = path.join(os.tmpdir(), "two-page.pdf");
    const cr80Target = path.join(os.tmpdir(), "two-page-cr80.pdf");
    fs.writeFileSync(originalTarget, await original.save());
    fs.writeFileSync(cr80Target, await cr80.save());
    console.log(`Created ${originalTarget}`);
    console.log(`Created ${cr80Target}`);
})();
