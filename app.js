require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const net = require("net");
const { exec, execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const bwipjs = require("bwip-js");
const PDFDocument = require("pdfkit");
const {
    PDFDocument: PDFLibDocument,
    StandardFonts,
    rgb,
} = require("pdf-lib");

const app = express();
const PORT = process.env.PORT || 3001;
const SERVER_HOST = process.env.SERVER_HOST || "0.0.0.0";

// Optional network metadata (informational for deployment docs/diagnostics)
const NETWORK_FIXED_IP = process.env.NETWORK_FIXED_IP || "192.168.0.244";
const NETWORK_GATEWAY = process.env.NETWORK_GATEWAY || "192.168.1.246";
const NETWORK_SUBNET_MASK =
    process.env.NETWORK_SUBNET_MASK || "255.255.240.0";
const NETWORK_DNS_PRIMARY = process.env.NETWORK_DNS_PRIMARY || "192.168.0.249";
const NETWORK_DNS_SECONDARY = process.env.NETWORK_DNS_SECONDARY || "8.8.8.8";

const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

const TRUSTED_CLIENT_IPS = new Set(
    String(process.env.TRUSTED_CLIENT_IPS || "")
        .split(",")
        .map((ip) => ip.trim())
        .filter(Boolean),
);

// Middleware
app.use(
    cors({
        origin(origin, callback) {
            if (!origin || ALLOWED_ORIGINS.length === 0) {
                callback(null, true);
                return;
            }

            if (ALLOWED_ORIGINS.includes(origin)) {
                callback(null, true);
                return;
            }

            callback(new Error("Origin not allowed by CORS"));
        },
    }),
);
app.use(bodyParser.json());

function normalizeIp(ip) {
    if (!ip) {
        return "";
    }

    const raw = String(ip).trim();
    if (raw === "::1") {
        return "127.0.0.1";
    }

    return raw.startsWith("::ffff:") ? raw.slice(7) : raw;
}

function getClientIp(req) {
    const forwarded = req.headers["x-forwarded-for"];
    if (forwarded) {
        const first = String(forwarded).split(",")[0];
        return normalizeIp(first);
    }

    return normalizeIp(req.socket && req.socket.remoteAddress);
}

app.use((req, res, next) => {
    if (TRUSTED_CLIENT_IPS.size === 0) {
        next();
        return;
    }

    const clientIp = getClientIp(req);
    const localAllowed = clientIp === "127.0.0.1";
    const trusted = TRUSTED_CLIENT_IPS.has(clientIp);

    if (localAllowed || trusted) {
        next();
        return;
    }

    res.status(403).json({
        success: false,
        error: `Client IP ${clientIp || "unknown"} is not allowed`,
    });
});

// ============================================================================
// CONFIGURATION
// ============================================================================

// Printer connection method: 'network' or 'usb'
const CONNECTION_TYPE = process.env.CONNECTION_TYPE || "usb";

// For network printing
const PRINTER_IP = process.env.PRINTER_IP || "192.168.1.100";
const PRINTER_PORT = process.env.PRINTER_PORT || 9100;

// For USB printing (printer name as shown in system)
const PRINTER_NAME = process.env.PRINTER_NAME || "ZDesigner ZC300";

// Print format: 'zpl' or 'barcode'.
// 'barcode' generates a Code128 image from cardNumber and prints it via driver.
const ALLOWED_PRINT_FORMATS = new Set(["zpl", "barcode"]);
const rawPrintFormat = String(process.env.PRINT_FORMAT || "barcode")
    .trim()
    .toLowerCase();
const PRINT_FORMAT = ALLOWED_PRINT_FORMATS.has(rawPrintFormat)
    ? rawPrintFormat
    : "barcode";

if (rawPrintFormat !== PRINT_FORMAT) {
    console.warn(
        `Invalid PRINT_FORMAT="${rawPrintFormat}". Falling back to "${PRINT_FORMAT}".`,
    );
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Generates minimal ZPL for production card printing.
 * Layout: card number text + Code128 barcode from card number.
 */
function generateCardZPL(cardData) {
    const { cardNumber } = cardData;

    const zpl = `
^XA

^MMT
^PW812
^LL406
^LS0

^FT50,80^A0N,40,40^FH^CI28^FDCard: ${cardNumber || ""}^FS^CI27

^FT50,250^BY3,3,120^BCN,120,Y,N,N
^FD${cardNumber}^FS

^PQ1,0,1,Y
^XZ
`;

    return zpl;
}

/**
 * Generate a barcode image buffer (PNG) from the card number.
 */
function generateBarcodePng(cardNumber) {
    return new Promise((resolve, reject) => {
        bwipjs.toBuffer(
            {
                bcid: "code128",
                text: String(cardNumber || ""),
                scale: 3,
                height: 14,
                includetext: false,
                textxalign: "center",
                backgroundcolor: "FFFFFF",
            },
            (err, png) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(png);
            },
        );
    });
}

/**
 * Decode a data URL image string to Buffer.
 */
function parseDataUrlImageBuffer(dataUrl) {
    const match = String(dataUrl || "").match(
        /^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/,
    );
    if (!match) {
        throw new Error("Invalid data URL image format");
    }
    return Buffer.from(match[1], "base64");
}

/**
 * Fetch image bytes from URL (or data URL) for card rendering.
 */
async function loadPhotoBuffer(photoUrl) {
    if (!photoUrl) {
        return null;
    }

    if (String(photoUrl).startsWith("data:image/")) {
        return parseDataUrlImageBuffer(photoUrl);
    }

    if (typeof fetch !== "function") {
        throw new Error(
            "Global fetch is not available in this Node.js runtime",
        );
    }

    const response = await fetch(photoUrl);
    if (!response.ok) {
        throw new Error(`Failed to download photo: HTTP ${response.status}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) {
        throw new Error(
            `photoUrl is not an image (content-type: ${contentType || "unknown"})`,
        );
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
}

/**
 * Render a fixed-size CR80 PDF with card number on top and barcode below.
 * This avoids printer-side full-page image scaling.
 */
async function generateBarcodeCardPdf(cardNumber, photoBuffer = null) {
    const safeNumber = String(cardNumber || "").trim();
    const barcodePng = await generateBarcodePng(safeNumber);

    // CR80 card in points: 3.37in x 2.125in at 72pt/in
    const cardWidthPt = 242.64;
    const cardHeightPt = 153.0;

    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({
            size: [cardWidthPt, cardHeightPt],
            margin: 0,
            info: { Title: "Card Barcode Print" },
        });

        const chunks = [];
        doc.on("data", (chunk) => chunks.push(chunk));
        doc.on("error", reject);
        doc.on("end", () => resolve(Buffer.concat(chunks)));

        doc.rect(0, 0, cardWidthPt, cardHeightPt).fill("#FFFFFF");
        doc.fillColor("#000000");

        if (photoBuffer) {
            // Left photo block when image is provided.
            const photoX = 10;
            const photoY = 16;
            const photoW = 70;
            const photoH = 95;
            doc.image(photoBuffer, photoX, photoY, {
                fit: [photoW, photoH],
                align: "center",
                valign: "center",
            });

            // Right text + barcode block.
            const contentX = 90;
            const contentW = cardWidthPt - contentX - 10;
            doc.font("Helvetica").fontSize(13);
            doc.text(safeNumber, contentX, 20, {
                width: contentW,
                align: "center",
            });

            doc.image(barcodePng, contentX + 6, 58, {
                fit: [contentW - 12, 50],
                align: "center",
                valign: "center",
            });
        } else {
            // Centered text + barcode block without photo.
            doc.font("Helvetica").fontSize(16);
            doc.text(safeNumber, 0, 18, {
                width: cardWidthPt,
                align: "center",
            });

            const barcodeWidth = 165;
            const barcodeHeight = 50;
            const barcodeX = (cardWidthPt - barcodeWidth) / 2;
            const barcodeY = 58;
            doc.image(barcodePng, barcodeX, barcodeY, {
                width: barcodeWidth,
                height: barcodeHeight,
            });
        }

        doc.end();
    });
}

// Two-sided printing from template PDFs (pdfs/front.pdf + pdfs/back.pdf)
const DUPLEX_TEMPLATES = process.env.DUPLEX_TEMPLATES === "true";
const TEMPLATE_DIR = process.env.TEMPLATE_DIR || path.join(__dirname, "pdfs");
const DUPLEX_RIBBON_COMBINATION =
    process.env.DUPLEX_RIBBON_COMBINATION || "1FrontYmckoBackYmcko";

async function embedImageAuto(pdfDoc, buffer) {
    const isPng = buffer.slice(0, 4).toString("hex") === "89504e47";
    return isPng ? pdfDoc.embedPng(buffer) : pdfDoc.embedJpg(buffer);
}

/**
 * Build a 2-page PDF: front template + database data (page 1), back template (page 2).
 */
async function generateDuplexTemplatePdf(cardNumber, photoBuffer = null) {
    const safeNumber = String(cardNumber || "").trim();
    const barcodePng = await generateBarcodePng(safeNumber);

    const frontDoc = await PDFLibDocument.load(
        fs.readFileSync(path.join(TEMPLATE_DIR, "front.pdf")),
    );
    const backDoc = await PDFLibDocument.load(
        fs.readFileSync(path.join(TEMPLATE_DIR, "back.pdf")),
    );

    const out = await PDFLibDocument.create();
    const [frontPage] = await out.copyPages(frontDoc, [0]);
    const [backPage] = await out.copyPages(backDoc, [0]);
    out.addPage(frontPage);
    out.addPage(backPage);

    const { width, height } = frontPage.getSize();
    const font = await out.embedFont(StandardFonts.HelveticaBold);
    const black = rgb(0, 0, 0);

    // pdf-lib origin is bottom-left; y values below are measured from the top.
    const fromTop = (y, h = 0) => height - y - h;

    if (photoBuffer) {
        try {
            const photo = await embedImageAuto(out, photoBuffer);
            const box = { x: 25, y: 18, w: 106, h: 106 };
            const scale = Math.min(box.w / photo.width, box.h / photo.height);
            const w = photo.width * scale;
            const h = photo.height * scale;
            frontPage.drawImage(photo, {
                x: box.x + (box.w - w) / 2,
                y: fromTop(box.y + (box.h - h) / 2, h),
                width: w,
                height: h,
            });
        } catch (err) {
            console.warn(`⚠️  Photo could not be embedded: ${err.message}`);
        }
    }

    const fontSize = 13;
    const textWidth = font.widthOfTextAtSize(safeNumber, fontSize);
    frontPage.drawText(safeNumber, {
        x: (width - textWidth) / 2,
        y: fromTop(138),
        size: fontSize,
        font,
        color: black,
    });

    const barcode = await out.embedPng(barcodePng);
    const barcodeW = width - 40;
    const barcodeH = 34;
    frontPage.drawImage(barcode, {
        x: 20,
        y: fromTop(148, barcodeH),
        width: barcodeW,
        height: barcodeH,
    });

    return Buffer.from(await out.save());
}

/**
 * Get list of available printers (macOS/Windows/Linux)
 */
function getAvailablePrinters() {
    return new Promise((resolve, reject) => {
        let cmd;

        if (os.platform() === "darwin") {
            // macOS
            // Force C locale so parsing stays stable on non-English systems.
            cmd = "LC_ALL=C lpstat -p | awk '/^printer / {print $2}'";
        } else if (os.platform() === "win32") {
            // Windows
            cmd =
                'powershell -NoProfile -Command "Get-Printer | Select-Object -ExpandProperty Name"';
        } else {
            // Linux
            cmd = "lpstat -p | awk '{print $2}'";
        }

        exec(cmd, (error, stdout, stderr) => {
            if (error) {
                reject(error);
                return;
            }

            const printers = stdout
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => line && line !== "Name");

            resolve(printers);
        });
    });
}

/**
 * Send ZPL data to Zebra printer via network (TCP/IP)
 */
function sendToNetworkPrinter(ip, port, zplData) {
    return new Promise((resolve, reject) => {
        const client = new net.Socket();
        let connected = false;

        client.connect(port, ip, () => {
            connected = true;
            console.log(`✓ Connected to printer at ${ip}:${port}`);
            client.write(zplData);
        });

        client.on("data", (data) => {
            console.log("Printer response:", data.toString());
        });

        client.on("close", () => {
            if (connected) {
                console.log("✓ Connection closed");
                resolve({ success: true, method: "network" });
            }
        });

        client.on("error", (err) => {
            console.error("Network error:", err.message);
            reject(
                new Error(
                    `Cannot connect to printer at ${ip}:${port} - ${err.message}`,
                ),
            );
        });

        // Close connection after sending
        setTimeout(() => {
            client.end();
        }, 1000);
    });
}

/**
 * Send ZPL data to USB printer using system print command
 */
function sendToUSBPrinter(printerName, zplData) {
    return new Promise((resolve, reject) => {
        // Create temp file with ZPL data
        const tempFile = path.join(os.tmpdir(), `zebra_${Date.now()}.zpl`);

        fs.writeFile(tempFile, zplData, (err) => {
            if (err) {
                reject(err);
                return;
            }

            let cmd;
            if (os.platform() === "darwin") {
                // macOS
                // Use lp to get a job id back for easier diagnostics.
                cmd = `lp -d "${printerName}" -o raw "${tempFile}"`;
            } else if (os.platform() === "win32") {
                // Windows
                cmd = `notepad /p "${tempFile}"`; // Will need printer.dll or PrintDirect.exe for proper raw printing
            } else {
                // Linux
                cmd = `lp -d "${printerName}" -o raw "${tempFile}"`;
            }

            exec(cmd, (error, stdout, stderr) => {
                // Clean up temp file
                fs.unlink(tempFile, () => {});

                if (error) {
                    reject(new Error(`Print command failed: ${error.message}`));
                    return;
                }

                const output = `${stdout || ""}${stderr || ""}`.trim();
                const normalizedOutput = output.replace(/[–—−]/g, "-");
                const jobMatch = normalizedOutput.match(
                    /\b([A-Za-z0-9_\-]+-\d+)\b/,
                );
                const jobId = jobMatch ? jobMatch[1] : null;

                console.log(
                    "✓ Print job sent to USB printer",
                    jobId ? `(${jobId})` : "",
                );
                resolve({
                    success: true,
                    method: "usb",
                    jobId,
                    commandOutput: output,
                });
            });
        });
    });
}

/**
 * Run a system command without shell interpolation.
 */
function runCommand(command, args = []) {
    return new Promise((resolve) => {
        execFile(command, args, (error, stdout, stderr) => {
            resolve({
                success: !error,
                command,
                args,
                code:
                    error && typeof error.code !== "undefined" ? error.code : 0,
                stdout: String(stdout || "").trim(),
                stderr: String(stderr || "").trim(),
                error: error ? error.message : null,
            });
        });
    });
}

/**
 * Run a PowerShell script and return structured output.
 */
function runPowerShell(script) {
    const shell = os.platform() === "win32" ? "powershell.exe" : "powershell";
    return runCommand(shell, [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
    ]);
}

/**
 * Escape a string for a PowerShell single-quoted literal.
 */
function escapePowerShellSingleQuoted(value) {
    return String(value || "").replace(/'/g, "''");
}

/**
 * Resolve a Windows executable from an explicit path or PATH lookup.
 */
async function resolveWindowsExecutable(candidates) {
    for (const candidate of candidates.filter(Boolean)) {
        if (path.isAbsolute(candidate) || /[\\/]/.test(candidate)) {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
            continue;
        }

        const lookup = await runCommand("where.exe", [candidate]);
        if (!lookup.success || !lookup.stdout) {
            continue;
        }

        const resolved = lookup.stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find(Boolean);

        if (resolved) {
            return resolved;
        }
    }

    return null;
}

/**
 * Attempt to recover a stuck CUPS queue for the configured printer.
 */
async function cleanupPrinterQueueCups(printerName) {
    const cancelAll = await runCommand("cancel", ["-a", printerName]);
    const disable = await runCommand("cupsdisable", [printerName]);
    const enable = await runCommand("cupsenable", [printerName]);
    const status = await runCommand("lpstat", ["-p", printerName]);

    const combinedCancelOutput =
        `${cancelAll.stdout} ${cancelAll.stderr}`.toLowerCase();
    const cancelIsNonBlocking =
        cancelAll.success ||
        combinedCancelOutput.includes("not found") ||
        combinedCancelOutput.includes("no jobs") ||
        combinedCancelOutput.includes("unknown");

    const success = cancelIsNonBlocking && disable.success && enable.success;

    return {
        success,
        printer: printerName,
        steps: {
            cancelAll: {
                ...cancelAll,
                treatedAsSuccess: cancelIsNonBlocking,
            },
            disable,
            enable,
            status,
        },
    };
}

/**
 * Attempt to recover a stuck Windows print queue for the configured printer.
 */
async function cleanupPrinterQueueWindows(printerName) {
    const safePrinterName = escapePowerShellSingleQuoted(printerName);

    const clearJobsScript = `$p='${safePrinterName}'; if (Get-Command Get-PrintJob -ErrorAction SilentlyContinue) { Get-PrintJob -PrinterName $p -ErrorAction SilentlyContinue | Remove-PrintJob -ErrorAction SilentlyContinue; Write-Output 'Print jobs cleared (if any).'; } else { Write-Output 'Get-PrintJob cmdlet unavailable on this system.'; }`;
    const restartSpoolerScript =
        "Restart-Service -Name Spooler -Force; Write-Output 'Spooler restarted.'";
    const statusScript = `$p='${safePrinterName}'; if (Get-Command Get-Printer -ErrorAction SilentlyContinue) { Get-Printer -Name $p | Select-Object Name,PrinterStatus,WorkOffline,DriverName | ConvertTo-Json -Compress; } else { Write-Output 'Get-Printer cmdlet unavailable on this system.'; }`;

    const clearJobs = await runPowerShell(clearJobsScript);
    const restartSpooler = await runPowerShell(restartSpoolerScript);
    const status = await runPowerShell(statusScript);

    return {
        success: clearJobs.success && restartSpooler.success,
        printer: printerName,
        steps: {
            clearJobs,
            restartSpooler,
            status,
        },
    };
}

/**
 * Attempt to recover a stuck print queue based on current OS.
 */
async function cleanupPrinterQueue(printerName) {
    if (os.platform() === "win32") {
        return cleanupPrinterQueueWindows(printerName);
    }

    return cleanupPrinterQueueCups(printerName);
}

/**
 * Print a generated PDF on Windows.
 * Strategy: silent CLI tools only to avoid opening a PDF viewer window.
 */
async function printPdfOnWindows(printerName, pdfFilePath) {
    const configuredSumatraPath = String(
        process.env.SUMATRA_PDF_PATH || "",
    ).trim();
    const sumatraCandidates = [
        configuredSumatraPath,
        path.join(
            process.env.LOCALAPPDATA || "",
            "SumatraPDF",
            "SumatraPDF.exe",
        ),
        path.join(
            process.env.PROGRAMFILES || "",
            "SumatraPDF",
            "SumatraPDF.exe",
        ),
        path.join(
            process.env["PROGRAMFILES(X86)"] || "",
            "SumatraPDF",
            "SumatraPDF.exe",
        ),
        "SumatraPDF.exe",
        "sumatrapdf.exe",
    ].filter(Boolean);

    const sumatraExecutable = await resolveWindowsExecutable(sumatraCandidates);

    if (sumatraExecutable) {
        const printResult = await runCommand(sumatraExecutable, [
            "-print-to",
            printerName,
            // Duplex comes from the driver's Printing Defaults; Sumatra's duplex flag overrides it.
            ...(DUPLEX_TEMPLATES ? ["-print-settings", "noscale"] : []),
            "-silent",
            "-exit-on-print",
            pdfFilePath,
        ]);

        if (printResult.success) {
            return {
                success: true,
                strategy: "sumatra",
                details: printResult,
            };
        }
    }

    const configuredAdobeReaderPath = String(
        process.env.ADOBE_READER_PATH || "",
    ).trim();
    const adobeCandidates = [
        configuredAdobeReaderPath,
        path.join(
            process.env.PROGRAMFILES || "",
            "Adobe",
            "Acrobat DC",
            "Acrobat",
            "Acrobat.exe",
        ),
        path.join(
            process.env["PROGRAMFILES(X86)"] || "",
            "Adobe",
            "Acrobat Reader DC",
            "Reader",
            "AcroRd32.exe",
        ),
        path.join(
            process.env.PROGRAMFILES || "",
            "Adobe",
            "Acrobat Reader DC",
            "Reader",
            "AcroRd32.exe",
        ),
        "AcroRd32.exe",
        "Acrobat.exe",
    ].filter(Boolean);

    const adobeExecutable = await resolveWindowsExecutable(adobeCandidates);

    if (adobeExecutable) {
        const printResult = await runCommand(adobeExecutable, [
            "/h",
            "/t",
            pdfFilePath,
            printerName,
        ]);

        if (printResult.success) {
            return {
                success: true,
                strategy: "adobe-reader-cli",
                details: printResult,
            };
        }
    }

    return {
        success: false,
        strategy: "none",
        details: {
            stdout: "",
            stderr: "",
            error:
                "No silent PDF printer was found on Windows. Install SumatraPDF or Adobe Reader, or set SUMATRA_PDF_PATH / ADOBE_READER_PATH.",
        },
    };
}

/**
 * Send generated barcode image through printer driver.
 */
function sendBarcodeImageToUSBPrinter(printerName, cardData) {
    return new Promise(async (resolve, reject) => {
        try {
            const safeCardNumber = String(cardData.cardNumber || "").trim();
            let photoBuffer = null;

            if (cardData.photoUrl) {
                try {
                    photoBuffer = await loadPhotoBuffer(cardData.photoUrl);
                } catch (photoError) {
                    console.warn(
                        `⚠️  Photo could not be loaded, printing without photo: ${photoError.message}`,
                    );
                }
            }

            const pdfBuffer = DUPLEX_TEMPLATES
                ? await generateDuplexTemplatePdf(safeCardNumber, photoBuffer)
                : await generateBarcodeCardPdf(safeCardNumber, photoBuffer);
            const tempFile = path.join(
                os.tmpdir(),
                `zebra_barcode_${Date.now()}.pdf`,
            );

            fs.writeFile(tempFile, pdfBuffer, async (err) => {
                if (err) {
                    reject(err);
                    return;
                }

                if (os.platform() === "win32") {
                    try {
                        const winResult = await printPdfOnWindows(
                            printerName,
                            tempFile,
                        );
                        fs.unlink(tempFile, () => {});

                        if (!winResult.success) {
                            const detailText = [
                                winResult.details && winResult.details.stdout,
                                winResult.details && winResult.details.stderr,
                                winResult.details && winResult.details.error,
                            ]
                                .filter(Boolean)
                                .join(" | ");
                            reject(
                                new Error(
                                    `Barcode print command failed on Windows: ${detailText || "no additional details"}`,
                                ),
                            );
                            return;
                        }

                        const output =
                            `${winResult.details.stdout || ""}${winResult.details.stderr || ""}`.trim();
                        console.log(
                            `✓ Barcode image print job sent (win32, ${winResult.strategy})`,
                        );
                        resolve({
                            success: true,
                            method: "usb-barcode-win32",
                            printStrategy: winResult.strategy,
                            commandOutput: output,
                            photoIncluded: Boolean(photoBuffer),
                        });
                        return;
                    } catch (winErr) {
                        fs.unlink(tempFile, () => {});
                        reject(
                            new Error(
                                `Barcode print command failed on Windows: ${winErr.message}`,
                            ),
                        );
                        return;
                    }
                }

                let cmd;
                if (os.platform() === "darwin" || os.platform() === "linux") {
                    const duplexOpts = DUPLEX_TEMPLATES
                        ? ` -o Orientation=1Portrait -o DualSidePrinting=1true -o RibbonCombination=${DUPLEX_RIBBON_COMBINATION}`
                        : "";
                    cmd = `lp -d "${printerName}" -o PageSize=CR80 -o CardSource=1Feeder -o CardDestination=0Hopper${duplexOpts} "${tempFile}"`;
                } else {
                    cmd = `lp -d "${printerName}" "${tempFile}"`;
                }

                exec(cmd, (error, stdout, stderr) => {
                    fs.unlink(tempFile, () => {});

                    if (error) {
                        reject(
                            new Error(
                                `Barcode print command failed: ${error.message}`,
                            ),
                        );
                        return;
                    }

                    const output = `${stdout || ""}${stderr || ""}`.trim();
                    const normalizedOutput = output.replace(/[–—−]/g, "-");
                    const jobMatch = normalizedOutput.match(
                        /\b([A-Za-z0-9_\-]+-\d+)\b/,
                    );
                    const jobId = jobMatch ? jobMatch[1] : null;

                    console.log(
                        "✓ Barcode image print job sent",
                        jobId ? `(${jobId})` : "",
                    );
                    resolve({
                        success: true,
                        method: "usb-barcode",
                        jobId,
                        commandOutput: output,
                        photoIncluded: Boolean(photoBuffer),
                    });
                });
            });
        } catch (error) {
            reject(new Error(`Barcode generation failed: ${error.message}`));
        }
    });
}

/**
 * Main function to send to printer (routes to network or USB)
 */
function sendToPrinter(zplData) {
    if (CONNECTION_TYPE === "network") {
        return sendToNetworkPrinter(PRINTER_IP, PRINTER_PORT, zplData);
    } else {
        return sendToUSBPrinter(PRINTER_NAME, zplData);
    }
}

/**
 * Print card using configured format.
 */
function printCardData(cardData) {
    if (PRINT_FORMAT === "barcode") {
        if (CONNECTION_TYPE !== "usb") {
            throw new Error(
                "PRINT_FORMAT=barcode is only supported with CONNECTION_TYPE=usb",
            );
        }

        return sendBarcodeImageToUSBPrinter(PRINTER_NAME, cardData);
    }
    const zplData = generateCardZPL(cardData);
    return sendToPrinter(zplData);
}

// ============================================================================
// API ENDPOINTS
// ============================================================================

/**
 * Health check endpoint
 */
app.get("/health", (req, res) => {
    res.json({
        status: "online",
        service: "Zebra ZC300 Print Service",
        host: SERVER_HOST,
        port: Number(PORT),
        clientIp: getClientIp(req),
        timestamp: new Date().toISOString(),
    });
});

/**
 * Network information endpoint for diagnostics/deployment verification.
 */
app.get("/network-info", (req, res) => {
    res.json({
        success: true,
        listening: {
            host: SERVER_HOST,
            port: Number(PORT),
        },
        stationNetwork: {
            fixedIp: NETWORK_FIXED_IP,
            gateway: NETWORK_GATEWAY,
            subnetMask: NETWORK_SUBNET_MASK,
            dnsPrimary: NETWORK_DNS_PRIMARY,
            dnsSecondary: NETWORK_DNS_SECONDARY,
        },
        trustedClientIps: Array.from(TRUSTED_CLIENT_IPS),
        allowedOrigins: ALLOWED_ORIGINS,
    });
});

/**
 * Get available printers
 */
app.get("/printers", async (req, res) => {
    try {
        const printers = await getAvailablePrinters();
        res.json({
            success: true,
            connectionType: CONNECTION_TYPE,
            printers: printers,
            currentPrinter:
                CONNECTION_TYPE === "network"
                    ? `${PRINTER_IP}:${PRINTER_PORT}`
                    : PRINTER_NAME,
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * Main print endpoint - receives card data and prints to Zebra
 */
app.post("/print", async (req, res) => {
    try {
        const cardData = req.body;

        // Validate required fields
        if (!cardData.cardNumber) {
            return res.status(400).json({
                success: false,
                error: "cardNumber is required",
            });
        }

        console.log("📄 Print request received:", {
            cardNumber: cardData.cardNumber,
            timestamp: new Date().toISOString(),
        });

        // Print in configured format (zpl or barcode)
        const result = await printCardData(cardData);

        res.json({
            success: true,
            message: "Card sent to printer successfully",
            method: result.method,
            format: PRINT_FORMAT,
            jobId: result.jobId || null,
            photoIncluded: Boolean(result.photoIncluded),
            printer:
                CONNECTION_TYPE === "network"
                    ? `${PRINTER_IP}:${PRINTER_PORT}`
                    : PRINTER_NAME,
        });
    } catch (error) {
        console.error("❌ Print error:", error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * Test print endpoint - prints a simple test card
 */
app.post("/test", async (req, res) => {
    try {
        const testCard = {
            cardNumber: "TEST-" + Date.now(),
        };
        const result = await printCardData(testCard);
        res.json({
            success: true,
            message: "Test card sent to printer",
            method: result.method,
            format: PRINT_FORMAT,
            jobId: result.jobId || null,
            testData: testCard,
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * Cleanup endpoint - clears pending jobs and resets spooler/queue.
 */
app.post("/cleanup", async (req, res) => {
    try {
        if (CONNECTION_TYPE !== "usb") {
            return res.status(400).json({
                success: false,
                error: "cleanup endpoint is intended for usb queue mode",
            });
        }

        const result = await cleanupPrinterQueue(PRINTER_NAME);
        const statusCode = result.success ? 200 : 500;

        return res.status(statusCode).json({
            success: result.success,
            message: result.success
                ? "Printer queue cleanup completed"
                : "Printer queue cleanup ran with errors",
            printer: result.printer,
            connectionType: CONNECTION_TYPE,
            steps: result.steps,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

// ============================================================================
// START SERVER
// ============================================================================

app.listen(PORT, SERVER_HOST, async () => {
    console.log("════════════════════════════════════════════════════════════");
    console.log(
        "   🖨️  ZEBRA ZC300 LOCAL PRINT SERVICE                       ",
    );
    console.log("════════════════════════════════════════════════════════════");
    console.log(`Server running on: http://${SERVER_HOST}:${PORT}`);
    console.log(`Connection type: ${CONNECTION_TYPE.toUpperCase()}`);
    console.log(`Print format: ${PRINT_FORMAT.toUpperCase()}`);

    if (CONNECTION_TYPE === "network") {
        console.log(`Printer: ${PRINTER_IP}:${PRINTER_PORT}`);
    } else {
        console.log(`🖨️  Printer: ${PRINTER_NAME}`);
    }

    console.log("");
    console.log("Available endpoints:");
    console.log(`  GET  /health   - Health check`);
    console.log(`  GET  /network-info - Network config diagnostics`);
    console.log(`  GET  /printers - List available printers`);
    console.log(`  POST /print    - Print card`);
    console.log(`  POST /test     - Print test card`);
    console.log(`  POST /cleanup  - Reset printer queue/spooler`);
    console.log("");

    console.log("Network profile:");
    console.log(`  Fixed IP: ${NETWORK_FIXED_IP}`);
    console.log(`  Gateway: ${NETWORK_GATEWAY}`);
    console.log(`  Subnet: ${NETWORK_SUBNET_MASK}`);
    console.log(`  DNS: ${NETWORK_DNS_PRIMARY} / ${NETWORK_DNS_SECONDARY}`);
    console.log(
        `  Trusted clients: ${TRUSTED_CLIENT_IPS.size ? Array.from(TRUSTED_CLIENT_IPS).join(", ") : "(none - all accepted)"}`,
    );
    console.log(
        `  CORS origins: ${ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(", ") : "(none - all accepted)"}`,
    );
    console.log("");

    // List available printers on startup
    try {
        const printers = await getAvailablePrinters();
        console.log("🖨️  Available system printers:");
        printers.forEach((p) => {
            console.log(`   - ${p}`);
        });
    } catch (error) {
        console.error("⚠️  Could not list printers:", error.message);
    }

    console.log("");
    console.log("✓ Service ready to receive print requests");
    console.log("════════════════════════════════════════════════════════════");
});

// Error handling
process.on("uncaughtException", (error) => {
    console.error("Uncaught Exception:", error);
});

process.on("unhandledRejection", (reason, promise) => {
    console.error("Unhandled Rejection at:", promise, "reason:", reason);
});
