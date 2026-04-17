const express = require('express');
const net = require('net');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const app = express();

const LOGOS_DIR = path.join(__dirname, 'Logos');
const fsp = fs.promises;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/logos', express.static(LOGOS_DIR));

// --- ZPL Generator ---
async function buildZPL(label) {
  const { width, height, dpi, elements, copies = 1 } = label;
  // Convert inches to dots
  const W = Math.round(width * dpi);
  const H = Math.round(height * dpi);

  let zpl = `^XA\n^PW${W}\n^LL${H}\n^CI28\n`;

  for (const el of elements) {
    const x = Math.round(el.x);
    const y = Math.round(el.y);

    if (el.type === 'text') {
      const fontHeight = Math.round((el.fontSize || 30) * (dpi / 72));
      const fontWidth = Math.round(fontHeight * 0.6);
      const bold = el.bold ? 'B' : '0';
      zpl += `^FO${x},${y}^A${bold !== 'B' ? '0' : '0'}N,${fontHeight},${fontWidth}^FD${el.value || ''}^FS\n`;
    }

    else if (el.type === 'barcode') {
      const barH = Math.round(el.barcodeHeight || 80);
      const narrow = el.narrowBar || 3;
      const sym = el.symbology || 'code128';
      if (sym === 'code128') {
        zpl += `^FO${x},${y}^BY${narrow}\n^BCN,${barH},Y,N,N\n^FD${el.value || '123456789'}^FS\n`;
      } else if (sym === 'ean13') {
        zpl += `^FO${x},${y}^BY${narrow}\n^BEN,${barH},Y,N\n^FD${el.value || '0000000000000'}^FS\n`;
      } else if (sym === 'upca') {
        zpl += `^FO${x},${y}^BY${narrow}\n^BUN,${barH},Y,N\n^FD${el.value || '00000000000'}^FS\n`;
      } else if (sym === 'code39') {
        zpl += `^FO${x},${y}^BY${narrow}\n^B3N,N,${barH},Y,N\n^FD${el.value || 'ABC123'}^FS\n`;
      }
    }

    else if (el.type === 'qr') {
      const mag = el.magnification || 4;
      zpl += `^FO${x},${y}^BQN,2,${mag}\n^FDMM,A${el.value || 'https://example.com'}^FS\n`;
    }

    else if (el.type === 'line') {
      const w = Math.round(el.w || 100);
      const lh = Math.round(el.lineHeight || 2);
      zpl += `^FO${x},${y}^GB${w},${lh},${lh}^FS\n`;
    }

    else if (el.type === 'box') {
      const bw = Math.round(el.w || 100);
      const bh = Math.round(el.h || 50);
      const thick = el.thickness || 2;
      zpl += `^FO${x},${y}^GB${bw},${bh},${thick}^FS\n`;
    }

    else if (el.type === 'logo') {
      const logoPath = getLogoPath(el.logoName);
      if (!logoPath) continue;
      const logoW = Math.max(1, Math.round(el.w || 120));
      const logoH = Math.max(1, Math.round(el.h || 60));
      const { width: imgW, height: imgH, bytesPerRow, packed } = await rasterizeLogo(el.logoName, logoW, logoH);
      zpl += `^FO${x},${y}${createZplGraphicHex(imgW, imgH, bytesPerRow, packed)}\n`;
    }
  }

  zpl += `^PQ${copies}\n^XZ\n`;
  return zpl;
}

function toPrintableAscii(value) {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[^\x20-\x7E]/g, '')
    .trim();
}

function chooseCplStringFont(fontSize) {
  const target = Math.max(5, Math.round(fontSize || 12));
  const fonts = [
    { name: '3X5', h: 5 },
    { name: '5X7', h: 7 },
    { name: '8X8', h: 8 },
    { name: '9X12', h: 12 },
    { name: '12X16', h: 16 },
    { name: '18X23', h: 23 },
    { name: '24X31', h: 31 }
  ];

  let best = fonts[0];
  let bestDelta = Math.abs(target - best.h);
  for (const f of fonts) {
    const delta = Math.abs(target - f.h);
    if (delta < bestDelta) {
      best = f;
      bestDelta = delta;
    }
  }
  return best.name;
}

function clampBarcodeNarrow(n) {
  return Math.max(1, Math.min(9, Math.round(n || 1)));
}

function barcodeModifiers(symbology, narrowBar) {
  const n = clampBarcodeNarrow(narrowBar || 2);
  const w = Math.max(n + 1, Math.min(9, n * 2));
  // '-' hides human-readable subtext to match designer preview.
  return `(${n}:${w})-`;
}

function estimateBarcodeModules(symbology, value) {
  const valueLen = String(value || '123456789').length;
  if (symbology === 'ean13' || symbology === 'upca') return 95;
  if (symbology === 'code39') return Math.max(45, 13 * valueLen + 25);
  return Math.max(55, 11 * (valueLen + 2) + 13); // code128-ish estimate
}

function estimateNarrowBarFromWidth(symbology, value, width) {
  const w = Math.max(20, Math.round(width || 120));
  const modules = estimateBarcodeModules(symbology, value);
  // Choose the nearest supported narrow-bar value (1..9) to match designer width.
  const raw = w / Math.max(1, modules);
  return clampBarcodeNarrow(Math.round(raw));
}

function safeLogoName(name) {
  const base = path.basename(String(name || ''));
  return base && base === String(name || '') ? base : null;
}

function getLogoPath(name) {
  const safe = safeLogoName(name);
  if (!safe) return null;
  return path.join(LOGOS_DIR, safe);
}

async function listLogos() {
  try {
    const entries = await fsp.readdir(LOGOS_DIR, { withFileTypes: true });
    const allowed = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.webp']);
    const logos = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!allowed.has(ext)) continue;
      const fullPath = path.join(LOGOS_DIR, entry.name);
      const meta = await sharp(fullPath).metadata().catch(() => ({}));
      logos.push({
        name: entry.name,
        width: meta.width || null,
        height: meta.height || null
      });
    }
    return logos.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

async function rasterizeLogo(name, width, height) {
  const filePath = getLogoPath(name);
  if (!filePath) {
    throw new Error('Invalid logo name');
  }

  const targetWidth = Math.max(1, Math.round(width || 1));
  const targetHeight = Math.max(1, Math.round(height || 1));
  const { data } = await sharp(filePath)
    .resize(targetWidth, targetHeight, { fit: 'fill', kernel: sharp.kernel.nearest })
    .flatten({ background: '#ffffff' })
    .grayscale()
    .threshold(128)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const bytesPerRowUnpadded = Math.ceil(targetWidth / 8);
  const bytesPerRow = Math.ceil(bytesPerRowUnpadded / 4) * 4;
  const packed = Buffer.alloc(bytesPerRow * targetHeight, 0);

  for (let y = 0; y < targetHeight; y += 1) {
    const srcRow = y * targetWidth;
    const destRow = (targetHeight - 1 - y) * bytesPerRow;
    for (let x = 0; x < targetWidth; x += 1) {
      if (data[srcRow + x] < 128) {
        packed[destRow + Math.floor(x / 8)] |= 1 << (7 - (x % 8));
      }
    }
  }

  return { width: targetWidth, height: targetHeight, bytesPerRow, packed };
}

function createBmpBuffer(width, height, packed) {
  const fileHeader = Buffer.alloc(14);
  const infoHeader = Buffer.alloc(40);
  const palette = Buffer.from([255, 255, 255, 0, 0, 0, 0, 0]);
  const fileSize = fileHeader.length + infoHeader.length + palette.length + packed.length;

  fileHeader.write('BM', 0, 'ascii');
  fileHeader.writeUInt32LE(fileSize, 2);
  fileHeader.writeUInt32LE(0, 6);
  fileHeader.writeUInt32LE(fileHeader.length + infoHeader.length + palette.length, 10);

  infoHeader.writeUInt32LE(infoHeader.length, 0);
  infoHeader.writeInt32LE(width, 4);
  infoHeader.writeInt32LE(height, 8);
  infoHeader.writeUInt16LE(1, 12);
  infoHeader.writeUInt16LE(1, 14);
  infoHeader.writeUInt32LE(0, 16);
  infoHeader.writeUInt32LE(packed.length, 20);
  infoHeader.writeInt32LE(2835, 24);
  infoHeader.writeInt32LE(2835, 28);
  infoHeader.writeUInt32LE(2, 32);
  infoHeader.writeUInt32LE(2, 36);

  return Buffer.concat([fileHeader, infoHeader, palette, packed]);
}

function createZplGraphicHex(width, height, bytesPerRow, packed) {
  return `^GFA,${packed.length},${packed.length},${bytesPerRow},${packed.toString('hex').toUpperCase()}`;
}

// --- CPL Generator (Cognitive Programming Language) ---
async function buildCPL(label, options = {}) {
  const preview = Boolean(options.preview);
  const { width, height, dpi, elements, copies = 1 } = label;
  const W = Math.round(width * dpi);
  const H = Math.round(height * dpi);
  const offsetX = Math.max(-20, Math.min(20, Math.round(label?.offsetX || 0)));
  const offsetY = Math.max(-20, Math.min(20, Math.round(label?.offsetY || 0)));
  const graphicChunks = [];
  const printableLines = [];

  for (const el of elements) {
    const x = Math.max(0, Math.round((el.x || 0) + offsetX));
    const y = Math.max(0, Math.round((el.y || 0) + offsetY));

    if (el.type === 'text') {
      const text = toPrintableAscii(el.value || '');
      const font = chooseCplStringFont(el.fontSize || 12);
      if (text) printableLines.push(`STRING ${font} ${x} ${y} ${text}`);
    }

    else if (el.type === 'barcode') {
      const maxBarH = Math.max(20, H - y - 2);
      const barH = Math.min(256, Math.max(20, Math.min(Math.round(el.h || el.barcodeHeight || 80), maxBarH)));
      const map = {
        code128: 'CODE128B',
        ean13: 'EAN13',
        upca: 'UPCA+',
        code39: 'CODE39'
      };
      const symKey = el.symbology || 'code128';
      const sym = map[symKey] || 'CODE128B';
      const value = toPrintableAscii(el.value || '123456789');
      const availableW = Math.max(20, W - x - 6);
      const targetW = Math.max(20, Math.min(Math.round(el.w || 120), availableW));
      const inferredNarrow = estimateNarrowBarFromWidth(symKey, value, targetW);
      const mods = barcodeModifiers(symKey, inferredNarrow);
      // CPL BARCODE expects y at the lower-left of the barcode block; UI y is top-left.
      const barcodeY = Math.min(H - 1, y + barH);
      if (value) printableLines.push(`BARCODE ${sym}${mods} ${x} ${barcodeY} ${barH} ${value}`);
    }

    else if (el.type === 'qr') {
      const value = toPrintableAscii(el.value || 'https://example.com');
      if (value) {
        const inferredMag = Math.round((Math.min(el.w || 80, el.h || 80)) / 24);
        const mag = Math.min(10, Math.max(1, Math.round(el.magnification || inferredMag || 3)));
        printableLines.push(`BARCODE QR ${x} ${y} ${mag} M=2 A~`);
        printableLines.push(`~QA,${value}~`);
      }
    }

    else if (el.type === 'line') {
      const w = Math.max(1, Math.round(el.w || 100));
      const lh = Math.max(1, Math.round(el.lineHeight || 2));
      printableLines.push(`FILL_BOX ${x} ${y} ${w} ${lh}`);
    }

    else if (el.type === 'box') {
      const bw = Math.max(2, Math.round(el.w || 100));
      const bh = Math.max(2, Math.round(el.h || 50));
      const thick = Math.max(1, Math.round(el.thickness || 2));
      printableLines.push(`FILL_BOX ${x} ${y} ${bw} ${thick}`);
      printableLines.push(`FILL_BOX ${x} ${y + bh - thick} ${bw} ${thick}`);
      printableLines.push(`FILL_BOX ${x} ${y} ${thick} ${bh}`);
      printableLines.push(`FILL_BOX ${x + bw - thick} ${y} ${thick} ${bh}`);
    }

    else if (el.type === 'logo') {
      const logoPath = getLogoPath(el.logoName);
      if (!logoPath) continue;
      const logoW = Math.max(1, Math.round(el.w || 120));
      const logoH = Math.max(1, Math.round(el.h || 60));
      if (preview) {
        printableLines.push(`GRAPHIC BMP ${x} ${y} ${el.logoName}`);
      } else {
        const { width: imgW, height: imgH, bytesPerRow, packed } = await rasterizeLogo(el.logoName, logoW, logoH);
        graphicChunks.push(Buffer.from(`! 0 100 ${H} 0\r\nGRAPHIC BMP ${x} ${y}\r\n`, 'utf8'));
        graphicChunks.push(createBmpBuffer(imgW, imgH, packed));
        graphicChunks.push(Buffer.from('\r\n', 'utf8'));
      }
    }
  }

  const asciiBody = [`!+ 0 100 ${H} ${Math.max(1, copies)}`]
    .concat(printableLines)
    .concat(['END'])
    .join('\r\n') + '\r\n';

  if (graphicChunks.length) {
    graphicChunks.push(Buffer.from(asciiBody, 'utf8'));
    return Buffer.concat(graphicChunks);
  }

  return asciiBody;
}

// --- Send ZPL to printer via TCP ---
function sendToPrinter(ip, port, zpl) {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    const timeout = 5000;
    client.setTimeout(timeout);
    client.connect(port, ip, () => {
      const payload = Buffer.isBuffer(zpl) ? zpl : Buffer.from(String(zpl), 'utf8');
      client.write(payload, () => {
        client.end();
        resolve({ success: true });
      });
    });
    client.on('timeout', () => { client.destroy(); reject(new Error('Connection timed out')); });
    client.on('error', (err) => reject(err));
  });
}

function checkTcpReachability(ip, port) {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    const timeout = 5000;

    client.setTimeout(timeout);
    client.once('connect', () => {
      client.end();
      resolve({ success: true });
    });
    client.once('timeout', () => {
      client.destroy();
      reject(new Error('Connection timed out'));
    });
    client.once('error', (err) => reject(err));

    client.connect(port, ip);
  });
}

// --- Routes ---
app.get('/api/logos', async (req, res) => {
  try {
    const logos = await listLogos();
    res.json({ logos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/print', async (req, res) => {
  const { label, printer } = req.body;
  if (!label || !printer || !printer.ip) {
    return res.status(400).json({ error: 'Missing label or printer.ip' });
  }
  try {
    const language = (printer.language || 'cpl').toLowerCase();
    const command = language === 'zpl' ? await buildZPL(label) : await buildCPL(label);
    await sendToPrinter(printer.ip, printer.port || 9100, command);
    res.json({ success: true, message: `Sent ${label.copies || 1} label(s) to ${printer.ip} using ${language.toUpperCase()}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/zpl-preview', async (req, res) => {
  const { label, printer } = req.body;
  if (!label) return res.status(400).json({ error: 'Missing label' });
  const language = (printer?.language || 'cpl').toLowerCase();
  try {
    const command = language === 'zpl' ? await buildZPL(label) : await buildCPL(label, { preview: true });
    res.json({ zpl: command, command, language });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/test-connection', async (req, res) => {
  const { ip, port = 9100 } = req.body;
  if (!ip) return res.status(400).json({ error: 'Missing ip' });
  try {
    await checkTcpReachability(ip, port);
    res.json({ success: true, message: 'Printer is reachable' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3222;
app.listen(PORT, () => {
  console.log(`\n  Label Studio running at http://localhost:${PORT}\n`);
});
