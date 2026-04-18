# Cognitive Label Studio

A web-based label designer and print server for thermal printers, supporting both **ZPL** (Zebra Programming Language) and **CPL** (Cognitive Programming Language) output. Design labels visually in the browser, preview the generated print commands, and send them directly to networked printers over TCP.

---

## Features

-  **Dual language output** — generates ZPL or CPL commands from the same label design
-  **Visual label designer** — drag-and-drop canvas served as a static web UI
-  **Rich element support** — text, barcodes (Code 128, EAN-13, UPC-A, Code 39), QR codes, lines, boxes, and logo images
-  **Logo/image support** — uploads rasterized to 1-bit BMP and embedded directly in print commands via Sharp
-  **TCP print dispatch** — sends print jobs directly to a printer IP/port (default `9100`)
-  **Printer connectivity test** — verify a printer is reachable before sending a job
-  **Command preview** — inspect the raw ZPL/CPL output before printing

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js |
| Web framework | Express |
| Image processing | [Sharp](https://sharp.pixelplumbing.com/) |
| Printer protocol | Raw TCP (port 9100) |
| Frontend | Static HTML/JS (`public/`) |

---

## Prerequisites

- **Node.js** v16 or later
- A networked thermal printer supporting ZPL or CPL (reachable via TCP)

---

## Installation

```bash
git clone https://github.com/cgolden15/cognitive-label-studio.git
cd cognitive-label-studio
npm install
```

---

## Usage

### Start the server

```bash
node server.js
```

The server starts on port **3222** by default. Open your browser to:

```
http://localhost:3222
```

You can override the port with an environment variable:

```bash
PORT=8080 node server.js
```

### Add logos

Place any `.png`, `.jpg`, `.jpeg`, `.bmp`, or `.webp` image files into the `Logos/` directory. They will be available for use as logo elements in the designer and will be automatically rasterized to 1-bit when printing.

---

## API Reference

All endpoints accept and return JSON unless otherwise noted.

### `GET /api/logos`
Returns a list of available logo images from the `Logos/` directory.

**Response:**
```json
{
  "logos": [
    { "name": "company.png", "width": 200, "height": 80 }
  ]
}
```

---

### `POST /api/print`
Generates a ZPL or CPL print command and sends it to the target printer over TCP.

**Request body:**
```json
{
  "label": {
    "width": 4,
    "height": 2,
    "dpi": 203,
    "copies": 1,
    "elements": [ ... ]
  },
  "printer": {
    "ip": "192.168.1.100",
    "port": 9100,
    "language": "cpl"
  }
}
```

`language` accepts `"zpl"` or `"cpl"` (default: `"cpl"`).

**Response:**
```json
{ "success": true, "message": "Sent 1 label(s) to 192.168.1.100 using CPL" }
```

---

### `POST /api/zpl-preview`
Returns the generated ZPL or CPL command string without sending it to a printer.

**Request body:** Same as `/api/print` (the `printer` field is optional — used only to determine language).

**Response:**
```json
{
  "command": "!+ 0 100 406 1\r\nSTRING ...\r\nEND\r\n",
  "language": "cpl"
}
```

---

### `POST /api/test-connection`
Checks whether a printer is reachable via TCP.

**Request body:**
```json
{ "ip": "192.168.1.100", "port": 9100 }
```

**Response:**
```json
{ "success": true, "message": "Printer is reachable" }
```

---

## Label Element Reference

Each element in the `elements` array has a `type` field and a set of type-specific properties. Coordinates (`x`, `y`) are in dots.

| Type | Key Properties |
|---|---|
| `text` | `value`, `fontSize`, `bold` |
| `barcode` | `value`, `symbology` (`code128`, `ean13`, `upca`, `code39`), `barcodeHeight`, `narrowBar`, `w` |
| `qr` | `value` (URL or string), `magnification` |
| `line` | `w`, `lineHeight` |
| `box` | `w`, `h`, `thickness` |
| `logo` | `logoName` (filename in `Logos/`), `w`, `h` |

---

## Project Structure

```
cognitive-label-studio/
├── server.js          # Express server, ZPL/CPL generators, TCP print dispatch
├── public/            # Static frontend (label designer UI)
├── Logos/             # Logo image files for embedding in labels
└── package.json
```

---

## License

This project is licensed under the [Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)](https://creativecommons.org/licenses/by-nc/4.0/) license.
 
You are free to share and adapt the material for **non-commercial purposes**, provided appropriate credit is given. Commercial use is not permitted.
 
