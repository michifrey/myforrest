'use strict';

/**
 * Sending e-mail without external dependencies: a minimal SMTP client
 * (RFC 5321) with implicit TLS (`smtps://`, port 465) or STARTTLS
 * (`smtp://`, port 587), AUTH PLAIN, and plain-text UTF-8 messages.
 *
 *   SMTP_URL=smtps://user:password@smtp.example.org
 *   MAIL_FROM="MyForrest <wald@example.org>"
 *
 * Credentials are only ever sent over TLS; a server without STARTTLS is
 * refused, except on localhost (a local relay or a test server).
 * Without SMTP_URL, `createMailer` returns a mailer that writes the message
 * to the log instead, so links can be followed during development.
 */

const crypto = require('node:crypto');
const net = require('node:net');
const tls = require('node:tls');
const os = require('node:os');

const TIMEOUT_MS = 15000;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
// Rejects anything that could break out of an address in a header or an SMTP command.
const SAFE_ADDRESS = /^[^\s@<>,;:"()\\[\]]+@[^\s@<>,;:"()\\[\]]+$/;

/** RFC 2047 encoded word for non-ASCII header values. */
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);

/** Splits `Name <addr>` into its parts. */
function parseMailbox(s) {
  const m = String(s).trim().match(/^(?:"?([^"<]*?)"?\s*)?<([^>]+)>$/);
  const address = (m ? m[2] : String(s)).trim();
  return { name: m?.[1]?.trim() || '', address };
}

function formatMessage({ from, to, subject, text, date = new Date() }) {
  const sender = parseMailbox(from);
  const domain = sender.address.split('@')[1] || 'localhost';
  const body = Buffer.from(text.replace(/\r?\n/g, '\r\n')).toString('base64').replace(/.{76}/g, '$&\r\n');
  return [
    `From: ${sender.name ? `${encodeHeader(sender.name)} <${sender.address}>` : sender.address}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomBytes(12).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');
}

/** Reads SMTP replies (possibly multi-line, "250-…" then "250 …") from a socket. */
function replyReader(socket) {
  let buffer = '';
  let lines = [];
  const queue = [];
  let waiting = null;
  let failure = null;
  const onData = (chunk) => {
    buffer += chunk.toString('utf8');
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).replace(/\r$/, '');
      buffer = buffer.slice(i + 1);
      lines.push(line);
      if (/^\d{3}(?: |$)/.test(line)) {
        const reply = { code: Number(line.slice(0, 3)), lines: lines.map((l) => l.slice(4)) };
        lines = [];
        if (waiting) { waiting.resolve(reply); waiting = null; } else queue.push(reply);
      }
    }
  };
  const onError = (err) => {
    failure = err;
    if (waiting) { waiting.reject(err); waiting = null; }
  };
  return {
    attach(s) {
      s.on('data', onData);
      s.on('error', onError);
      s.on('timeout', () => { onError(new Error('SMTP: Zeitüberschreitung')); s.destroy(); });
      s.on('close', () => onError(failure || new Error('SMTP: Verbindung geschlossen')));
    },
    detach(s) { s.removeAllListeners('data'); s.removeAllListeners('error'); s.removeAllListeners('timeout'); s.removeAllListeners('close'); },
    next() {
      if (queue.length) return Promise.resolve(queue.shift());
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => { waiting = { resolve, reject }; });
    },
    socket,
  };
}

/** Sends one message over SMTP. `url` is an smtp:// or smtps:// URL. */
async function sendSmtp(url, { from, to, subject, text }) {
  const u = new URL(url);
  if (!['smtp:', 'smtps:'].includes(u.protocol)) throw new Error('SMTP_URL muss mit smtp:// oder smtps:// beginnen');
  const implicitTls = u.protocol === 'smtps:';
  const host = u.hostname;
  const port = Number(u.port) || (implicitTls ? 465 : 587);
  const local = LOCAL_HOSTS.has(host);
  const user = decodeURIComponent(u.username);
  const pass = decodeURIComponent(u.password);
  const sender = parseMailbox(from).address;
  if (!SAFE_ADDRESS.test(sender) || !SAFE_ADDRESS.test(to)) throw new Error('Ungültige E-Mail-Adresse');

  let socket = implicitTls
    ? tls.connect({ host, port, servername: host })
    : net.connect({ host, port });
  socket.setTimeout(TIMEOUT_MS);
  let reader = replyReader(socket);
  reader.attach(socket);

  const command = async (line, expect) => {
    if (line !== null) socket.write(`${line}\r\n`);
    const reply = await reader.next();
    if (!expect.includes(reply.code)) {
      // Never echo the AUTH line, it carries the password.
      const what = line === null ? 'Begrüssung' : line.startsWith('AUTH') ? 'AUTH' : line.split(' ')[0];
      throw new Error(`SMTP ${what}: ${reply.code} ${reply.lines.join(' ')}`);
    }
    return reply;
  };

  try {
    await command(null, [220]);
    const helo = `EHLO ${os.hostname().replace(/[^\w.-]/g, '') || 'localhost'}`;
    let ehlo = await command(helo, [250]);
    if (!implicitTls) {
      const canTls = ehlo.lines.some((l) => /^STARTTLS\b/i.test(l));
      if (canTls) {
        await command('STARTTLS', [220]);
        reader.detach(socket);
        socket = tls.connect({ socket, servername: host });
        socket.setTimeout(TIMEOUT_MS);
        await new Promise((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject); });
        reader = replyReader(socket);
        reader.attach(socket);
        ehlo = await command(helo, [250]);
      } else if (!local) {
        throw new Error('SMTP-Server bietet kein STARTTLS an');
      }
    }
    if (user) {
      await command(`AUTH PLAIN ${Buffer.from(`\0${user}\0${pass}`).toString('base64')}`, [235]);
    }
    await command(`MAIL FROM:<${sender}>`, [250]);
    await command(`RCPT TO:<${to}>`, [250, 251]);
    await command('DATA', [354]);
    // Dot-stuffing: a line starting with "." gets a second one (the body is base64, the headers are ours).
    const data = formatMessage({ from, to, subject, text }).replace(/^\./gm, '..');
    await command(`${data}\r\n.`, [250]);
    await command('QUIT', [221]).catch(() => {});
  } finally {
    socket.destroy();
  }
}

/**
 * A mailer: `send({ to, subject, text })`. With an SMTP URL it delivers;
 * without, it logs the message (development) and reports `{ logged: true }`.
 */
function createMailer({ smtpUrl = process.env.SMTP_URL, from = process.env.MAIL_FROM, log = console.log } = {}) {
  if (!smtpUrl) {
    return {
      configured: false,
      async send({ to, subject, text }) {
        log(`E-Mail an ${to} nicht verschickt (kein SMTP_URL gesetzt):\n  ${subject}\n  ${text.replace(/\n/g, '\n  ')}`);
        return { logged: true };
      },
    };
  }
  const sender = from || `MyForrest <no-reply@${new URL(smtpUrl).hostname}>`;
  return {
    configured: true,
    async send({ to, subject, text }) {
      await sendSmtp(smtpUrl, { from: sender, to, subject, text });
      return { sent: true };
    },
  };
}

module.exports = { createMailer, sendSmtp, formatMessage, parseMailbox, SAFE_ADDRESS };
