require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const net = require('net');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const bwipjs = require('bwip-js');
const PDFDocument = require('pdfkit');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors()); // Allow API server to connect
app.use(bodyParser.json());

// ============================================================================
// CONFIGURATION
// ============================================================================

// Printer connection method: 'network' or 'usb'
const CONNECTION_TYPE = process.env.CONNECTION_TYPE || 'usb';

// For network printing
const PRINTER_IP = process.env.PRINTER_IP || '192.168.1.100';
const PRINTER_PORT = process.env.PRINTER_PORT || 9100;

// For USB printing (printer name as shown in system)
const PRINTER_NAME = process.env.PRINTER_NAME || 'ZDesigner ZC300';

// Print format: 'zpl', 'plain', or 'barcode'.
// 'barcode' generates a Code128 image from cardNumber and prints it via driver.
const PRINT_FORMAT = process.env.PRINT_FORMAT || 'zpl';

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

^FT50,80^A0N,40,40^FH^CI28^FDCard: ${cardNumber || ''}^FS^CI27

^FT50,250^BY3,3,120^BCN,120,Y,N,N
^FD${cardNumber}^FS

^PQ1,0,1,Y
^XZ
`;
    
    return zpl;
}

/**
 * Minimal ZPL for transport testing.
 * If this prints literally, the queue is not treating input as raw ZPL.
 */
function generateHelloWorldZPL() {
    return '^XA\n^FO50,50^A0N,40,40^FDHELLO WORLD^FS\n^XZ\n';
}

/**
 * Build a plain text card body for driver-based printing.
 */
function generatePlainCardText(cardData) {
    const { cardNumber } = cardData;
    return `${cardNumber || ''}`;
}

/**
 * Generate a barcode image buffer (PNG) from the card number.
 */
function generateBarcodePng(cardNumber) {
    return new Promise((resolve, reject) => {
        bwipjs.toBuffer({
            bcid: 'code128',
            text: String(cardNumber || ''),
            scale: 3,
            height: 14,
            includetext: false,
            textxalign: 'center',
            backgroundcolor: 'FFFFFF'
        }, (err, png) => {
            if (err) {
                reject(err);
                return;
            }
            resolve(png);
        });
    });
}

/**
 * Render a fixed-size CR80 PDF with card number on top and barcode below.
 * This avoids printer-side full-page image scaling.
 */
async function generateBarcodeCardPdf(cardNumber) {
    const safeNumber = String(cardNumber || '').trim();
    const barcodePng = await generateBarcodePng(safeNumber);

    // CR80 card in points: 3.37in x 2.125in at 72pt/in
    const cardWidthPt = 242.64;
    const cardHeightPt = 153.0;

    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({
            size: [cardWidthPt, cardHeightPt],
            margin: 0,
            info: { Title: 'Card Barcode Print' }
        });

        const chunks = [];
        doc.on('data', (chunk) => chunks.push(chunk));
        doc.on('error', reject);
        doc.on('end', () => resolve(Buffer.concat(chunks)));

        doc.rect(0, 0, cardWidthPt, cardHeightPt).fill('#FFFFFF');
        doc.fillColor('#000000');

        // Card number line
        doc.font('Helvetica').fontSize(16);
        doc.text(safeNumber, 0, 18, {
            width: cardWidthPt,
            align: 'center'
        });

        // Barcode image block below card number
        const barcodeWidth = 180;
        const barcodeHeight = 54;
        const barcodeX = (cardWidthPt - barcodeWidth) / 2;
        const barcodeY = 56;
        doc.image(barcodePng, barcodeX, barcodeY, {
            width: barcodeWidth,
            height: barcodeHeight
        });

        doc.end();
    });
}

/**
 * Get list of available printers (macOS/Windows/Linux)
 */
function getAvailablePrinters() {
    return new Promise((resolve, reject) => {
        let cmd;
        
        if (os.platform() === 'darwin') { // macOS
            // Force C locale so parsing stays stable on non-English systems.
            cmd = 'LC_ALL=C lpstat -p | awk \'/^printer / {print $2}\'';
        } else if (os.platform() === 'win32') { // Windows
            cmd = 'wmic printer get name';
        } else { // Linux
            cmd = 'lpstat -p | awk \'{print $2}\'';
        }
        
        exec(cmd, (error, stdout, stderr) => {
            if (error) {
                reject(error);
                return;
            }
            
            const printers = stdout
                .split('\n')
                .map(line => line.trim())
                .filter(line => line && line !== 'Name');
            
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
        
        client.on('data', (data) => {
            console.log('Printer response:', data.toString());
        });
        
        client.on('close', () => {
            if (connected) {
                console.log('✓ Connection closed');
                resolve({ success: true, method: 'network' });
            }
        });
        
        client.on('error', (err) => {
            console.error('Network error:', err.message);
            reject(new Error(`Cannot connect to printer at ${ip}:${port} - ${err.message}`));
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
            if (os.platform() === 'darwin') { // macOS
                // Use lp to get a job id back for easier diagnostics.
                cmd = `lp -d "${printerName}" -o raw "${tempFile}"`;
            } else if (os.platform() === 'win32') { // Windows
                cmd = `notepad /p "${tempFile}"`; // Will need printer.dll or PrintDirect.exe for proper raw printing
            } else { // Linux
                cmd = `lp -d "${printerName}" -o raw "${tempFile}"`;
            }
            
            exec(cmd, (error, stdout, stderr) => {
                // Clean up temp file
                fs.unlink(tempFile, () => {});
                
                if (error) {
                    reject(new Error(`Print command failed: ${error.message}`));
                    return;
                }
                
                const output = `${stdout || ''}${stderr || ''}`.trim();
                const normalizedOutput = output.replace(/[–—−]/g, '-');
                const jobMatch = normalizedOutput.match(/\b([A-Za-z0-9_\-]+-\d+)\b/);
                const jobId = jobMatch ? jobMatch[1] : null;

                console.log('✓ Print job sent to USB printer', jobId ? `(${jobId})` : '');
                resolve({ success: true, method: 'usb', jobId, commandOutput: output });
            });
        });
    });
}

/**
 * Send plain text via printer driver (non-raw path).
 * Useful for ZC300 diagnostics when raw ZPL does not render.
 */
function sendPlainTextToUSBPrinter(printerName, text) {
    return new Promise((resolve, reject) => {
        const tempFile = path.join(os.tmpdir(), `zebra_text_${Date.now()}.txt`);

        fs.writeFile(tempFile, `${text}\n`, (err) => {
            if (err) {
                reject(err);
                return;
            }

            let cmd;
            if (os.platform() === 'darwin' || os.platform() === 'linux') {
                cmd = `lp -d "${printerName}" -o PageSize=CR80 -o CardSource=1Feeder -o CardDestination=0Hopper "${tempFile}"`;
            } else if (os.platform() === 'win32') {
                cmd = `notepad /p "${tempFile}"`;
            } else {
                cmd = `lp -d "${printerName}" "${tempFile}"`;
            }

            exec(cmd, (error, stdout, stderr) => {
                fs.unlink(tempFile, () => {});

                if (error) {
                    reject(new Error(`Plain print command failed: ${error.message}`));
                    return;
                }

                const output = `${stdout || ''}${stderr || ''}`.trim();
                const normalizedOutput = output.replace(/[–—−]/g, '-');
                const jobMatch = normalizedOutput.match(/\b([A-Za-z0-9_\-]+-\d+)\b/);
                const jobId = jobMatch ? jobMatch[1] : null;

                console.log('✓ Plain text print job sent', jobId ? `(${jobId})` : '');
                resolve({ success: true, method: 'usb-driver', jobId, commandOutput: output });
            });
        });
    });
}

/**
 * Send generated barcode image through printer driver.
 */
function sendBarcodeImageToUSBPrinter(printerName, cardNumber) {
    return new Promise(async (resolve, reject) => {
        try {
            const pdfBuffer = await generateBarcodeCardPdf(cardNumber);
            const tempFile = path.join(os.tmpdir(), `zebra_barcode_${Date.now()}.pdf`);

            fs.writeFile(tempFile, pdfBuffer, (err) => {
                if (err) {
                    reject(err);
                    return;
                }

                let cmd;
                if (os.platform() === 'darwin' || os.platform() === 'linux') {
                    cmd = `lp -d "${printerName}" -o PageSize=CR80 -o CardSource=1Feeder -o CardDestination=0Hopper "${tempFile}"`;
                } else if (os.platform() === 'win32') {
                    reject(new Error('PRINT_FORMAT=barcode is not implemented for win32 yet'));
                    return;
                } else {
                    cmd = `lp -d "${printerName}" "${tempFile}"`;
                }

                exec(cmd, (error, stdout, stderr) => {
                    fs.unlink(tempFile, () => {});

                    if (error) {
                        reject(new Error(`Barcode print command failed: ${error.message}`));
                        return;
                    }

                    const output = `${stdout || ''}${stderr || ''}`.trim();
                    const normalizedOutput = output.replace(/[–—−]/g, '-');
                    const jobMatch = normalizedOutput.match(/\b([A-Za-z0-9_\-]+-\d+)\b/);
                    const jobId = jobMatch ? jobMatch[1] : null;

                    console.log('✓ Barcode image print job sent', jobId ? `(${jobId})` : '');
                    resolve({ success: true, method: 'usb-barcode', jobId, commandOutput: output });
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
    if (CONNECTION_TYPE === 'network') {
        return sendToNetworkPrinter(PRINTER_IP, PRINTER_PORT, zplData);
    } else {
        return sendToUSBPrinter(PRINTER_NAME, zplData);
    }
}

/**
 * Print card using configured format.
 */
function printCardData(cardData) {
    if (PRINT_FORMAT === 'barcode') {
        if (CONNECTION_TYPE !== 'usb') {
            throw new Error('PRINT_FORMAT=barcode is only supported with CONNECTION_TYPE=usb');
        }

        return sendBarcodeImageToUSBPrinter(PRINTER_NAME, cardData.cardNumber);
    }

    if (PRINT_FORMAT === 'plain') {
        if (CONNECTION_TYPE !== 'usb') {
            throw new Error('PRINT_FORMAT=plain is only supported with CONNECTION_TYPE=usb');
        }

        const plainText = generatePlainCardText(cardData);
        return sendPlainTextToUSBPrinter(PRINTER_NAME, plainText);
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
app.get('/health', (req, res) => {
    res.json({
        status: 'online',
        service: 'Zebra ZC300 Print Service',
        timestamp: new Date().toISOString()
    });
});

/**
 * Get available printers
 */
app.get('/printers', async (req, res) => {
    try {
        const printers = await getAvailablePrinters();
        res.json({
            success: true,
            connectionType: CONNECTION_TYPE,
            printers: printers,
            currentPrinter: CONNECTION_TYPE === 'network' 
                ? `${PRINTER_IP}:${PRINTER_PORT}`
                : PRINTER_NAME
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Main print endpoint - receives card data and prints to Zebra
 */
app.post('/print', async (req, res) => {
    try {
        const cardData = req.body;
        
        // Validate required fields
        if (!cardData.cardNumber) {
            return res.status(400).json({
                success: false,
                error: 'cardNumber is required'
            });
        }
        
        console.log('📄 Print request received:', {
            cardNumber: cardData.cardNumber,
            timestamp: new Date().toISOString()
        });
        
        // Print in configured format (zpl or plain)
        const result = await printCardData(cardData);
        
        res.json({
            success: true,
            message: 'Card sent to printer successfully',
            method: result.method,
            format: PRINT_FORMAT,
            jobId: result.jobId || null,
            printer: CONNECTION_TYPE === 'network' 
                ? `${PRINTER_IP}:${PRINTER_PORT}`
                : PRINTER_NAME
        });
        
    } catch (error) {
        console.error('❌ Print error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Test print endpoint - prints a simple test card
 */
app.post('/test', async (req, res) => {
    try {
        const testCard = {
            cardNumber: 'TEST-' + Date.now()
        };
        const result = await printCardData(testCard);
        res.json({
            success: true,
            message: 'Test card sent to printer',
            method: result.method,
            format: PRINT_FORMAT,
            jobId: result.jobId || null,
            testData: testCard
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Minimal transport test - prints only HELLO WORLD in ZPL.
 */
app.post('/test-hello', async (req, res) => {
    try {
        const zplData = generateHelloWorldZPL();
        const result = await sendToPrinter(zplData);
        res.json({
            success: true,
            message: 'Hello World test sent to printer',
            method: result.method,
            zpl: zplData
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Driver test endpoint - sends plain text through printer driver (no ZPL).
 */
app.post('/test-plain', async (req, res) => {
    try {
        if (CONNECTION_TYPE !== 'usb') {
            return res.status(400).json({
                success: false,
                error: 'test-plain is only available in usb connection mode'
            });
        }

        const text = (req.body && typeof req.body.text === 'string' && req.body.text.trim())
            ? req.body.text.trim()
            : 'HELLO WORLD';

        const result = await sendPlainTextToUSBPrinter(PRINTER_NAME, text);
        res.json({
            success: true,
            message: 'Plain text test sent to printer driver',
            method: result.method,
            printer: PRINTER_NAME,
            text,
            jobId: result.jobId,
            commandOutput: result.commandOutput
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ============================================================================
// START SERVER
// ============================================================================

app.listen(PORT, async () => {
    console.log('════════════════════════════════════════════════════════════');
    console.log('   🖨️  ZEBRA ZC300 LOCAL PRINT SERVICE                       ');
    console.log('════════════════════════════════════════════════════════════');
    console.log(`Server running on: http://localhost:${PORT}`);
    console.log(`Connection type: ${CONNECTION_TYPE.toUpperCase()}`);
    console.log(`Print format: ${PRINT_FORMAT.toUpperCase()}`);
    
    if (CONNECTION_TYPE === 'network') {
        console.log(`Printer: ${PRINTER_IP}:${PRINTER_PORT}`);
    } else {
        console.log(`🖨️  Printer: ${PRINTER_NAME}`);
    }
    
    console.log('');
    console.log('Available endpoints:');
    console.log(`  GET  /health   - Health check`);
    console.log(`  GET  /printers - List available printers`);
    console.log(`  POST /print    - Print card`);
    console.log(`  POST /test     - Print test card`);
    console.log(`  POST /test-hello - Print minimal HELLO WORLD ZPL`);
    console.log(`  POST /test-plain - Print plain text through driver`);
    console.log('');
    
    // List available printers on startup
    try {
        const printers = await getAvailablePrinters();
        console.log('🖨️  Available system printers:');
        printers.forEach(p => {
            console.log(`   - ${p}`);
        });
    } catch (error) {
        console.error('⚠️  Could not list printers:', error.message);
    }
    
    console.log('');
    console.log('✓ Service ready to receive print requests');
    console.log('════════════════════════════════════════════════════════════');
});

// Error handling
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
