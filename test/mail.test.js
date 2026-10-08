'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { sendSmtp, createMailer, formatMessage } = require('../src/mail');

/** A tiny SMTP server on localhost that records the session. */
async function fakeSmtp({ startTls = false, rejectAuth = false } = {}) {
  const log = { commands: [], data: '' };
  const server = net.createServer((socket) => {
    let inData = false;
    let buffer = '';
    socket.write('220 fake ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let i;
      while ((i = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; socket.write('250 queued\r\n'); } else log.data += `${line}\r\n`;
          continue;
        }
        log.commands.push(line);
        if (line.startsWith('EHLO')) socket.write(`250-fake\r\n250-AUTH PLAIN\r\n${startTls ? '250-STARTTLS\r\n' : ''}250 8BITMIME\r\n`);
        else if (line.startsWith('AUTH')) socket.write(rejectAuth ? '535 nope\r\n' : '235 ok\r\n');
        else if (line.startsWith('MAIL') || line.startsWith('RCPT')) socket.write('250 ok\r\n');
        else if (line === 'DATA') { inData = true; socket.write('354 go\r\n'); } else if (line === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); } else socket.write('500 what\r\n');
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { log, url: (auth = '') => `smtp://${auth}127.0.0.1:${server.address().port}`, close: () => server.close() };
}

test('sends a UTF-8 message with AUTH PLAIN to a local server', async () => {
  const smtp = await fakeSmtp();
  try {
    await sendSmtp(smtp.url('wald%40example.org:ge%3Aheim@'), {
      from: 'MyForrest Wälder <wald@example.org>', to: 'anna@example.org', subject: 'Grüezi', text: 'Hallo\n.Punkt am Anfang\nLink: https://x/y',
    });
    const auth = smtp.log.commands.find((c) => c.startsWith('AUTH PLAIN'));
    assert.equal(Buffer.from(auth.split(' ')[2], 'base64').toString(), '\0wald@example.org\0ge:heim');
    assert.ok(smtp.log.commands.includes('MAIL FROM:<wald@example.org>'));
    assert.ok(smtp.log.commands.includes('RCPT TO:<anna@example.org>'));
    assert.equal(smtp.log.commands.at(-1), 'QUIT');
    assert.match(smtp.log.data, /^Subject: =\?UTF-8\?B\?/m);
    assert.match(smtp.log.data, /^From: =\?UTF-8\?B\?.+\?= <wald@example\.org>/m);
    const body = smtp.log.data.split('\r\n\r\n')[1].replace(/\r\n/g, '');
    assert.equal(Buffer.from(body, 'base64').toString(), 'Hallo\r\n.Punkt am Anfang\r\nLink: https://x/y');
  } finally {
    smtp.close();
  }
});

test('reports server errors without leaking the password', async () => {
  const smtp = await fakeSmtp({ rejectAuth: true });
  try {
    await assert.rejects(
      sendSmtp(smtp.url('u:topsecret@'), { from: 'a@example.org', to: 'b@example.org', subject: 's', text: 't' }),
      (err) => /SMTP AUTH: 535/.test(err.message) && !err.message.includes('topsecret'),
    );
  } finally {
    smtp.close();
  }
});

test('refuses addresses that could inject commands or headers', async () => {
  await assert.rejects(
    sendSmtp('smtp://127.0.0.1:1', { from: 'a@example.org', to: 'b@example.org>\r\nRCPT TO:<c@example.org', subject: 's', text: 't' }),
    /Ungültige/,
  );
  assert.doesNotMatch(formatMessage({ from: 'a@example.org', to: 'b@example.org', subject: 'x\r\nBcc: c@example.org', text: 't' }), /^Bcc:/m);
});

test('without SMTP_URL the mailer logs the message', async () => {
  const lines = [];
  const mailer = createMailer({ smtpUrl: '', log: (s) => lines.push(s) });
  assert.equal(mailer.configured, false);
  assert.deepEqual(await mailer.send({ to: 'a@example.org', subject: 'Hallo', text: 'https://link' }), { logged: true });
  assert.match(lines[0], /https:\/\/link/);
});
