# 📘 Complete Setup Guide - Zebra ZC300 Print Service

This guide walks you through setting up the local print service step-by-step.

---

## 🎯 What You're Building

A local HTTP service that:
- Runs on the machine with your Zebra printer
- Listens on port 3001
- Receives print requests from your remote API
- Generates ZPL commands
- Sends them to your Zebra ZC300 printer

---

## ✅ Prerequisites Checklist

- [ ] Zebra ZC300 printer (physical device)
- [ ] Computer with Windows, macOS, or Linux
- [ ] Node.js installed (v14 or higher) - [Download here](https://nodejs.org/)
- [ ] Zebra printer drivers installed - [Download here](https://www.zebra.com/us/en/support-downloads.html)
- [ ] Printer connected (USB or Network)
- [ ] Blank cards loaded in printer
- [ ] Ribbon installed in printer

---

## 📝 Step-by-Step Setup

### Step 1: Verify Node.js Installation

```bash
node --version
# Should show: v14.x.x or higher

npm --version
# Should show: 6.x.x or higher
```

If not installed, download from [nodejs.org](https://nodejs.org/)

---

### Step 2: Navigate to Project Folder

```bash
cd /Users/denniszyche/Documents/app/localPrintZebra
```

---

### Step 3: Install Dependencies

```bash
npm install
```

This installs:
- express (web server)
- body-parser (JSON parsing)
- cors (cross-origin requests)
- dotenv (environment variables)

You should see: "added X packages" without errors.

---

### Step 4: Configure Printer Connection

Open the `.env` file in your editor and configure based on your setup:

#### For USB Connection (Most Common):

```env
PORT=3001
CONNECTION_TYPE=usb
PRINTER_NAME=ZDesigner ZC300
```

#### For Network Connection:

```env
PORT=3001
CONNECTION_TYPE=network
PRINTER_IP=192.168.1.100
PRINTER_PORT=9100
```

**Don't know your printer name yet?** That's okay, continue to Step 5.

---

### Step 5: Find Your USB Printer Name

**On macOS:**
```bash
lpstat -p
```

**On Windows:**
```bash
wmic printer get name
```

**On Linux:**
```bash
lpstat -p
```

Look for something like:
- `ZDesigner ZC300`
- `ZDesigner_ZC300`
- `Zebra ZC300`

**Or** just run the service and it will show you:
```bash
npm start
```

Look for the printer list in the startup output:
```
🖨️  Available system printers:
   - ZDesigner_ZC300    ← This is what you need!
   - Some_Other_Printer
```

Update your `.env` file with the exact name.

---

### Step 6: Start the Service

```bash
npm start
```

You should see:
```
╔════════════════════════════════════════════════════════════╗
║   🖨️  ZEBRA ZC300 LOCAL PRINT SERVICE                     ║
╚════════════════════════════════════════════════════════════╝
📡 Server running on: http://localhost:3001
🔌 Connection type: USB
🖨️  Printer: ZDesigner ZC300

Available endpoints:
  GET  /health   - Health check
  GET  /printers - List available printers
  POST /print    - Print card
  POST /test     - Print test card

🖨️  Available system printers:
   - ZDesigner_ZC300

✓ Service ready to receive print requests
════════════════════════════════════════════════════════════
```

✅ **Service is running!**

---

### Step 7: Test the Service

#### Test 1: Health Check
Open a new terminal and run:
```bash
curl http://localhost:3001/health
```

Expected response:
```json
{
  "status": "online",
  "service": "Zebra ZC300 Print Service",
  "timestamp": "2026-02-16T..."
}
```

#### Test 2: List Printers
```bash
curl http://localhost:3001/printers
```

Expected response:
```json
{
  "success": true,
  "connectionType": "usb",
  "printers": ["ZDesigner_ZC300"],
  "currentPrinter": "ZDesigner ZC300"
}
```

#### Test 3: Print Test Card
```bash
curl -X POST http://localhost:3001/test
```

Expected response:
```json
{
  "success": true,
  "message": "Test card sent to printer",
  "method": "usb",
  "testData": {
    "cardNumber": "TEST-1739745600000",
    "userName": "Test User",
    "userId": "TEST123",
    "expiryDate": "12/2025"
  }
}
```

**Check your printer!** It should start printing a test card.

---

### Step 8: Test from Your API

In your main API (the one with `printCardToZebra` function), make sure it's configured:

```javascript
// In your API's .env file
PRINTER_SERVICE_URL=http://localhost:3001
```

Then test calling the function:
```javascript
await printCardToZebra({
    cardNumber: "TEST123",
    userName: "John Doe",
    userId: "USR001",
    expiryDate: "12/2026"
});
```

---

## 🔧 Configuration Options

### USB Printing (Recommended for local setup)

**Pros:**
- Simple setup
- No network configuration needed
- Reliable connection

**Cons:**
- Computer must be physically connected to printer
- Can't print remotely

**.env configuration:**
```env
CONNECTION_TYPE=usb
PRINTER_NAME=ZDesigner ZC300
```

---

### Network Printing (For remote printing)

**Pros:**
- Print from any computer on network
- No USB cable needed
- Multiple computers can share printer

**Cons:**
- Requires network configuration
- Firewall may block connections
- Need to find printer IP

**.env configuration:**
```env
CONNECTION_TYPE=network
PRINTER_IP=192.168.1.100
PRINTER_PORT=9100
```

**How to find printer IP:**
1. On printer LCD: Menu → Network → TCP/IP → IP Address
2. Print a network configuration page from printer
3. Check your router's connected devices
4. Use Zebra Setup Utilities software

**Test network connection:**
```bash
ping 192.168.1.100
nc -zv 192.168.1.100 9100
```

---

## 🎨 Customizing Card Design

The card layout is defined in the `generateCardZPL()` function in `app.js`.

### Default Design:
```
┌─────────────────────────────┐
│                             │
│  John Doe                   │
│  Card: 12345678             │
│  User ID: USR001            │
│  Expiry: 12/2026            │
│                             │
│  |||||||||||||||||||        │  ← Barcode
│  12345678                   │
│                             │
└─────────────────────────────┘
```

### Customize Layout:

Edit positions in `app.js`:
```javascript
^FT50,50    // Position: X=50, Y=50 (top-left is 0,0)
^A0N,30,30  // Font: A0, Normal, Height=30, Width=30
^FD${userName}^FS  // Data to print
```

### Add Your Logo:

1. Convert logo to `.GRF` format using Zebra Designer
2. Upload to printer memory
3. Add to ZPL:
```javascript
^FT50,50^XGR:LOGO.GRF,1,1^FS
```

### Change to QR Code:

Replace barcode section:
```javascript
// Old Code 128 barcode:
^FT50,200^BY3,3,100^BCN,100,Y,N,N
^FD${cardNumber}^FS

// New QR Code:
^FT50,200^BQN,2,4
^FDQA,${cardNumber}^FS
```

---

## 🚨 Troubleshooting

### Problem: "EADDRINUSE: address already in use"

**Solution:** Port 3001 is already in use
```bash
# Find what's using the port
lsof -i :3001

# Kill that process
kill -9 [PID]

# Or change port in .env
PORT=3002
```

---

### Problem: "Printer not found"

**Solutions:**
1. Check printer is powered on
2. Check USB cable is connected
3. Verify drivers are installed
4. Run `lpstat -p` (macOS/Linux) or `wmic printer get name` (Windows)
5. Update `PRINTER_NAME` in `.env` with exact name from step above

---

### Problem: "Print job sent but nothing prints"

**Checklist:**
- [ ] Printer has blank cards loaded
- [ ] Ribbon is installed and not empty
- [ ] Printer is not in error state (check LCD/lights)
- [ ] Printer queue is not paused (check system settings)
- [ ] Test printing from another app (e.g., print test page)

**Check printer queue:**
- macOS: System Preferences → Printers & Scanners
- Windows: Control Panel → Devices and Printers
- Linux: `lpq -P [PRINTER_NAME]`

---

### Problem: "Cannot connect to network printer"

**Solutions:**
1. Verify printer IP: `ping [IP]`
2. Test port 9100: `nc -zv [IP] 9100` or `telnet [IP] 9100`
3. Check firewall isn't blocking connection
4. Verify printer's network printing is enabled
5. Try accessing printer web interface: `http://[IP]`

---

### Problem: ZPL commands not working correctly

**Debug steps:**
1. Copy ZPL output from console logs
2. Test at [labelary.com/viewer.html](https://labelary.com/viewer.html)
3. Adjust coordinates and sizes
4. Refer to [ZPL Programming Guide](https://www.zebra.com/content/dam/zebra/manuals/printers/common/programming/zpl-zbi2-pm-en.pdf)

---

## 🚀 Running in Production

### Keep Service Running 24/7

**Option 1: PM2 (Recommended)**
```bash
# Install PM2 globally
npm install -g pm2

# Start service
pm2 start app.js --name zebra-print

# Set to start on system boot
pm2 startup
pm2 save

# View logs
pm2 logs zebra-print

# Restart
pm2 restart zebra-print

# Stop
pm2 stop zebra-print
```

**Option 2: Run in Background (simple)**
```bash
# Start in background
nohup npm start &

# Check if running
ps aux | grep node

# Stop (find PID first)
kill [PID]
```

---

## 📊 Monitoring

### View Logs
When running with PM2:
```bash
pm2 logs zebra-print
```

When running normally, logs appear in terminal where you ran `npm start`.

### Check Service Status
```bash
# With PM2
pm2 status

# Or visit in browser
http://localhost:3001/health
```

---

## 🔒 Security (If exposing to network)

### Add Basic Authentication
Edit `app.js` and add:

```javascript
const AUTH_TOKEN = process.env.AUTH_TOKEN;

// Add middleware
app.use((req, res, next) => {
    const token = req.headers['authorization'];
    if (token !== `Bearer ${AUTH_TOKEN}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
});
```

In `.env`:
```env
AUTH_TOKEN=your-secret-token-here
```

Your API request becomes:
```javascript
headers: { 
    'Content-Type': 'application/json',
    'Authorization': 'Bearer your-secret-token-here'
}
```

---

## ✅ Setup Complete!

You now have:
- ✅ Local print service running
- ✅ Zebra printer connected and working
- ✅ API that can send print requests
- ✅ Test card printed successfully

**Next steps:**
1. Customize card design in `generateCardZPL()`
2. Test with real data from your API
3. Set up PM2 for production
4. Add authentication if needed

**Questions?** Review the [main README](README.md) or check troubleshooting section.
