# 🖨️ Zebra ZC300 Local Print Service

A Node.js service for printing ID cards on a Zebra ZC300 card printer. This service runs locally on the machine connected to the printer and receives print requests from your remote API.

---

## 📋 Quick Start

### 1️⃣ Install Dependencies
```bash
npm install
```

### 2️⃣ Configure Your Printer
Edit the `.env` file:

**For USB Connection (Recommended):**
```env
CONNECTION_TYPE=usb
PRINTER_NAME=ZDesigner ZC300
```

**For Network Connection:**
```env
CONNECTION_TYPE=network
PRINTER_IP=192.168.1.100
PRINTER_PORT=9100
```

### 3️⃣ Find Your Printer Name (USB only)
Run the service once to see available printers:
```bash
npm start
```

You'll see output like:
```
🖨️  Available system printers:
   - ZDesigner_ZC300
   - HP_LaserJet
   - Canon_Printer
```

Update `.env` with the exact printer name.

### 4️⃣ Run the Service
```bash
npm start
```

For development with auto-restart:
```bash
npm run dev
```

---

## 🏗️ Architecture

```
┌─────────────────┐         HTTP POST          ┌──────────────────┐
│   Your API      │ ────────────────────────▶  │  Print Service   │
│  (Remote)       │   localhost:3001/print     │   (This App)     │
└─────────────────┘                            └──────────────────┘
                                                        │
                                                        │ ZPL Commands
                                                        ▼
                                               ┌────────────────┐
                                               │ Zebra ZC300    │
                                               │ Card Printer   │
                                               └────────────────┘
```

**How it works:**
1. Your remote API calls `POST http://localhost:3001/print` (or your server IP)
2. This service receives card data (cardNumber, userName, userId, expiryDate)
3. Generates ZPL (Zebra Programming Language) commands
4. Sends to printer via USB or Network
5. Returns success/failure response

---

## 🔌 API Endpoints

### `GET /health`
Health check to verify service is running.

**Response:**
```json
{
  "status": "online",
  "service": "Zebra ZC300 Print Service",
  "timestamp": "2026-02-16T10:30:00.000Z"
}
```

**Test:**
```bash
curl http://localhost:3001/health
```

---

### `GET /printers`
List all available printers on the system.

**Response:**
```json
{
  "success": true,
  "connectionType": "usb",
  "printers": ["ZDesigner_ZC300", "HP_LaserJet"],
  "currentPrinter": "ZDesigner ZC300"
}
```

**Test:**
```bash
curl http://localhost:3001/printers
```

---

### `POST /print`
Print a card with provided data.

**Request Body:**
```json
{
  "cardNumber": "12345678",
  "userName": "John Doe",
  "userId": "USR001",
  "expiryDate": "12/2026"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Card sent to printer successfully",
  "method": "usb",
  "printer": "ZDesigner ZC300"
}
```

**Test:**
```bash
curl -X POST http://localhost:3001/print \
  -H "Content-Type: application/json" \
  -d '{
    "cardNumber": "12345678",
    "userName": "John Doe",
    "userId": "USR001",
    "expiryDate": "12/2026"
  }'
```

---

### `POST /test`
Print a test card with dummy data.

**Test:**
```bash
curl -X POST http://localhost:3001/test
```

---

## 🔧 Configuration

### Environment Variables (.env)

| Variable | Description | Default | Options |
|----------|-------------|---------|---------|
| `PORT` | Service port | `3001` | Any available port |
| `CONNECTION_TYPE` | How to connect to printer | `usb` | `usb` or `network` |
| `PRINTER_NAME` | USB printer name | `ZDesigner ZC300` | See `/printers` endpoint |
| `PRINTER_IP` | Network printer IP | `192.168.1.100` | Your printer's IP |
| `PRINTER_PORT` | Network printer port | `9100` | Usually 9100 for Zebra |

---

## 🔗 Integration with Your API

In your existing API (the one with `printCardToZebra` function), you're already set up! Just make sure this service is running:

```javascript
// Your API calls this local service
async function printCardToZebra(cardData) {
    const printServiceUrl = process.env.PRINTER_SERVICE_URL || "http://localhost:3001";
    
    try {
        const printResponse = await fetch(`${printServiceUrl}/print`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                cardNumber: cardData.cardNumber,
                userName: cardData.userName,
                userId: cardData.userId,
                expiryDate: cardData.expiryDate
            }),
        });
        
        if (!printResponse.ok) {
            console.error("Physical print failed:", await printResponse.text());
        } else {
            console.log("Physical card printed successfully");
        }
    } catch (printError) {
        console.error("Print service unreachable:", printError);
    }
}
```

**Important:** 
- If your API runs on the **same machine** as this service: use `http://localhost:3001`
- If your API runs on a **different machine**: use `http://[PRINT-SERVER-IP]:3001`

---

## 🖨️ Zebra ZC300 Setup

### Prerequisites
1. **Zebra Printer Drivers** - Download from [Zebra Support](https://www.zebra.com/us/en/support-downloads.html)
2. **Node.js** - Version 14 or higher
3. **Printer Connection** - USB cable or network configuration

### Printer Connection Options

#### Option 1: USB Connection (Easiest)
1. Connect printer via USB cable
2. Install Zebra drivers
3. Verify printer appears in system printers
4. Set `CONNECTION_TYPE=usb` in `.env`

#### Option 2: Network Connection
1. Configure printer's network settings (via printer control panel)
2. Note the printer's IP address
3. Verify you can ping the printer: `ping [PRINTER-IP]`
4. Set `CONNECTION_TYPE=network` in `.env`
5. Update `PRINTER_IP` with your printer's IP

### Finding Printer IP Address
- Check printer's LCD display: Settings → Network → TCP/IP
- Check your router's connected devices
- Use Zebra Setup Utilities software

---

## 🎨 Customizing Card Design

Edit the `generateCardZPL()` function in [app.js](app.js) to customize:
- Card layout and positioning
- Text fonts and sizes
- Barcode type (Code 128, QR Code, etc.)
- Add logos or images
- Change colors

### ZPL Resources
- [ZPL Programming Guide (PDF)](https://www.zebra.com/content/dam/zebra/manuals/printers/common/programming/zpl-zbi2-pm-en.pdf)
- [Online ZPL Viewer](https://labelary.com/viewer.html) - Test ZPL commands
- [ZPL Command Reference](http://www.zebra.com/content/dam/zebra_new_ia/en-us/manuals/printers/common/programming/zpl-zbi2-pm-en.pdf)

### Example: Adding QR Code
```javascript
// In generateCardZPL function, add:
^FT300,200^BQN,2,4
^FDQA,${cardNumber}^FS
```

---

## 🐛 Troubleshooting

### Service won't start
```bash
# Check if port 3001 is already in use
lsof -i :3001

# Kill the process if needed
kill -9 [PID]

# Or change port in .env
PORT=3002
```

### Printer not found (USB)
1. Verify printer is powered on and connected
2. Check printer drivers are installed
3. Run the service and check "Available system printers" list
4. Update `PRINTER_NAME` in `.env` with exact name

### Cannot connect to network printer
```bash
# Test network connectivity
ping [PRINTER-IP]

# Test if port 9100 is open
nc -zv [PRINTER-IP] 9100
# or
telnet [PRINTER-IP] 9100
```

If connection fails:
- Verify printer's IP address
- Check firewall settings
- Ensure printer's network printing is enabled

### Print job sent but nothing prints
1. Check printer has blank cards loaded
2. Verify ribbon is installed and not empty
3. Check for printer error lights
4. Open printer queue in system settings to see job status
5. Try printing from another application to verify printer works

### macOS permission issues
```bash
# Grant terminal full disk access
System Preferences → Security & Privacy → Privacy → Full Disk Access
→ Add Terminal
```

---

## 📦 Dependencies

| Package | Purpose |
|---------|---------|
| `express` | HTTP server for API endpoints |
| `body-parser` | Parse JSON request bodies |
| `cors` | Allow cross-origin requests from your API |
| `dotenv` | Load environment variables from .env |
| Built-in: `net` | TCP/IP socket communication for network printing |
| Built-in: `child_process` | Execute system print commands for USB |
| Built-in: `fs` | File system operations for temp files |

**No external printer libraries needed!** Uses native system commands.

---

## 🚀 Production Deployment

### Running as a Background Service

**Option 1: PM2 (Recommended)**
```bash
npm install -g pm2
pm2 start app.js --name zebra-print
pm2 startup
pm2 save
```

**Option 2: macOS LaunchAgent**
Create `~/Library/LaunchAgents/com.zebra.print.plist`

**Option 3: Linux systemd**
Create `/etc/systemd/system/zebra-print.service`

### Security Considerations
- Add authentication token in `.env`
- Use firewall to restrict access to trusted IPs only
- Run service as limited user, not root
- Use HTTPS reverse proxy (nginx) for remote access

---

## 📄 License

ISC

---

## 🆘 Support

**Common Issues:**
- Printer not detected → Check drivers and connections
- ZPL not working → Test commands at [labelary.com](https://labelary.com/viewer.html)
- Network timeout → Verify IP and firewall settings

**Need help?** Check the troubleshooting section above or review ZPL documentation.
