// Vercel Serverless Function for POST /api/careers/applications.
// Mirrors server.mjs validation and reference issuance so online Career applications work in production on Vercel.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROLES, isRole, questionsOf, answerFields, isAnswered, nationalDigits } from '../../public/careers/js/roles.js';
import { SECURITY_HEADERS } from '../../security.mjs';

const MAX_BODY = 16 * 1024 * 1024;
const MAX_CV = 10 * 1024 * 1024;
const RX_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const pad = n => String(n).padStart(2, '0');
const careersData = join(tmpdir(), 'sakshbooks-careers');

function sendJson(res, status, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
  if (typeof req.body === 'string') {
    try { return Promise.resolve(JSON.parse(req.body)); }
    catch { return Promise.reject(Object.assign(new Error('invalid json'), { status: 400 })); }
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('invalid json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

const looksLike = (ext, b) => ext === 'pdf' ? b.subarray(0, 4).toString() === '%PDF'
  : ext === 'docx' ? b[0] === 0x50 && b[1] === 0x4b
  : b.readUInt32BE(0) === 0xd0cf11e0;

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return sendJson(res, 405, { ok: false, error: 'Method not allowed' }); }
  if (!/application\/json/i.test(req.headers['content-type'] || '')) return sendJson(res, 415, { ok: false, error: 'Send the application as JSON' });
  let body;
  try { body = await readJson(req); }
  catch (e) { return sendJson(res, e.status || 400, { ok: false, error: e.status === 413 ? 'The upload is too large' : 'The request could not be read' }); }

  const role = isRole(body?.role) ? ROLES[body.role] : null;
  if (!role) return sendJson(res, 400, { ok: false, error: 'Choose a role', fields: {} });
  const s = v => (typeof v === 'string' ? v.trim() : '');
  const a = body.about || {};
  const fields = {};
  const digits = nationalDigits(s(a.cc) || '+91', s(a.phone));
  if (s(a.name).length < 2 || s(a.name).length > 80) fields.name = 'Enter your full name';
  if (!RX_EMAIL.test(s(a.email)) || s(a.email).length > 160) fields.email = 'Enter a valid email address';
  if (digits.length < 6 || digits.length > 15 || (s(a.cc) === '+91' && !/^[6-9]\d{9}$/.test(digits))) fields.phone = 'Enter a valid phone number';
  if (s(a.location).length < 2 || s(a.location).length > 80) fields.location = 'Enter the city you live in';
  if (!s(a.notice)) fields.notice = 'Choose your notice period';
  if (s(a.cvLink) && !/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(s(a.cvLink))) fields.cvLink = 'Enter a full link starting with https://';

  const answers = {};
  for (const q of questionsOf(body.role)) {
    for (const f of answerFields(q)) {
      const v = s(body.answers?.[f.id]);
      if (v.length > f.max) fields[q.id] = `Keep each answer under ${f.max} characters`;
      answers[f.id] = v;
    }
    if (!fields[q.id] && q.required && !isAnswered(q, answers)) fields[q.id] = 'This question is required';
  }

  let cv = null;
  if (body.cv) {
    const ext = (String(body.cv.name || '').match(/\.(pdf|docx?)$/i) || [])[1]?.toLowerCase();
    const buf = Buffer.from(String(body.cv.data || ''), 'base64');
    if (!ext) fields.cv = 'Upload a PDF, DOC or DOCX file';
    else if (!buf.length || buf.length > MAX_CV) fields.cv = 'The CV must be under 10 MB';
    else if (buf.length < 4 || !looksLike(ext, buf)) fields.cv = 'That file does not look like a PDF or Word document';
    else cv = { ext, buf, name: String(body.cv.name).replace(/[^\w .()-]/g, '_').slice(0, 120) };
  }
  if (!cv && !s(a.cvLink) && !fields.cv) fields.cv = 'Add your CV: upload it, or add a link in About You';
  if (body.confirm !== true) fields.confirm = 'Please confirm that your information is accurate';
  if (Object.keys(fields).length) return sendJson(res, 400, { ok: false, error: 'Please check the highlighted fields', fields });

  try {
    await mkdir(join(careersData, 'applications'), { recursive: true });
    await mkdir(join(careersData, 'cv'), { recursive: true });
    const clientId = String(body.clientId || '').replace(/[^\w-]/g, '').slice(0, 64);
    const indexPath = join(careersData, 'index.json');
    let index = {};
    try { index = JSON.parse(await readFile(indexPath, 'utf8')); } catch { index = {}; }
    if (clientId && index[clientId]) return sendJson(res, 200, { ok: true, reference: index[clientId], duplicate: true });

    const now = new Date();
    const reference = `ASC-${String(now.getFullYear()).slice(2)}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${randomBytes(3).toString('hex').toUpperCase()}`;
    let cvFile = null;
    if (cv) { cvFile = `${reference}.${cv.ext}`; await writeFile(join(careersData, 'cv', cvFile), cv.buf); }
    const record = {
      reference, receivedAt: now.toISOString(), clientId, role: body.role, roleTitle: role.title,
      about: { name: s(a.name), email: s(a.email).toLowerCase(), phone: `${s(a.cc) || '+91'} ${digits}`, location: s(a.location), cvLink: s(a.cvLink), notice: s(a.notice) },
      answers, cv: cv ? { file: cvFile, originalName: cv.name, bytes: cv.buf.length } : null,
      userAgent: String(req.headers['user-agent'] || '').slice(0, 200)
    };
    await writeFile(join(careersData, 'applications', `${reference}.json`), JSON.stringify(record, null, 2));
    if (clientId) { index[clientId] = reference; await writeFile(indexPath, JSON.stringify(index, null, 2)); }
    return sendJson(res, 201, { ok: true, reference, receivedAt: record.receivedAt });
  } catch (e) {
    console.error(e);
    return sendJson(res, 500, { ok: false, error: 'The application could not be saved. Please try again' });
  }
}
