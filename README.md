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

**For your new fixed-IP LAN setup (test:02-07-2026):**
```env
# Service listener
PORT=3001
SERVER_HOST=0.0.0.0

# Keep USB mode if printer is connected to this Windows PC
CONNECTION_TYPE=usb
PRINTER_NAME=ZDesigner ZC300
PRINT_FORMAT=barcode

# Restrict who can call this API (set your backend/server IP)
TRUSTED_CLIENT_IPS=YOUR_SERVER_IP

# Optional: restrict browser origins if needed
ALLOWED_ORIGINS=https://your-api-domain.com

# IT-provided network profile (informational, visible in /network-info)
```

**For USB Connection (Recommended):**
```env
CONNECTION_TYPE=usb
PRINTER_NAME=ZDesigner ZC300
PRINT_FORMAT=barcode
```

**For Network Connection:**
```env
CONNECTION_TYPE=network
PRINTER_IP=192.168.1.100
PRINTER_PORT=9100
PRINT_FORMAT=zpl
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

---

### `GET /network-info`
Shows listener settings, trusted client list, CORS list, and the configured station network profile.

**Test:**
```bash
curl http://localhost:3001/network-info
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
  "photoUrl": "https://example.com/photo.jpg"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Card sent to printer successfully",
  "method": "usb-barcode",
  "format": "barcode",
  "jobId": "PRINTER-123",
  "photoIncluded": true,
  "printer": "ZDesigner ZC300"
}
```

**Test:**
```bash
curl -X POST http://localhost:3001/print \
  -H "Content-Type: application/json" \
  -d '{
    "cardNumber": "12345678",
    "photoUrl": "https://example.com/photo.jpg"
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

### `POST /cleanup`
Clear pending jobs and reset the printer queue/spooler.

**Test:**
```bash
curl -X POST http://localhost:3001/cleanup
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

### Remote server cannot reach this PC
1. Verify the service is listening on all interfaces:
```bash
curl http://localhost:3001/network-info
```
Look for `"host":"0.0.0.0"` and `"port":3001`.

2. From your backend/server machine, test:
```bash
curl http://192.168.0.244:3001/health
```

3. If you configured `TRUSTED_CLIENT_IPS`, ensure it includes your backend server IP exactly.


Invoke-WebRequest -Uri "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf" -OutFile "$env:TEMP\test.pdf"
& "C:\Users\user\AppData\Local\SumatraPDF\SumatraPDF.exe" -print-to "Zebra_Technologies_ZTC_ZC300" -silent -exit-on-print "$env:TEMP\test.pdf"